/// <reference path="../phosphorus.ts" />
/// <reference path="extension.ts" />

namespace P.ext.cloud {
  export interface CloudHandler extends P.ext.Extension {
    variableChanged(name: string): void;
  }

  const UPDATE_INTERVAL = 100;

  export function getAllCloudVariables(stage: P.core.Stage) {
    const result = {};
    for (const variable of stage.cloudVariables) {
      result[variable] = stage.vars[variable] + '';
    }
    return result;
  }

  interface CloudDataMessage {
    kind: string;
  }

  interface CloudSetMessage {
    kind: 'set';
    var: string;
    value: string;
  }

  function isCloudDataMessage(data: unknown): data is CloudDataMessage {
    if (typeof data !== 'object' || !data) {
      return false;
    }
    return typeof (data as CloudDataMessage).kind === 'string';
  }

  function isCloudSetMessage(data: unknown): data is CloudSetMessage {
    return isCloudDataMessage(data) && typeof (data as CloudSetMessage).var === 'string' && typeof (data as CloudSetMessage).value === 'string';
  }

  export class WebSocketCloudHandler extends P.ext.Extension implements CloudHandler {
    private interval: number | null = null;
    private queuedVariableChanges: string[] = [];
    private ws: WebSocket | null = null;

    constructor(stage: P.core.Stage, private host: string, private id: string) {
      super(stage);
      this.update = this.update.bind(this);
    }

    variableChanged(name: string): void {
      if (this.queuedVariableChanges.indexOf(name) > -1) {
        // already queued, do not add again
        return;
      }
      this.queuedVariableChanges.push(name);
    }

    private update() {
      if (this.queuedVariableChanges.length === 0) {
        return;
      }
      const variableName = this.queuedVariableChanges.shift()!;
      const value = this.getVariable(variableName);
      this.send({
        kind: 'set',
        var: variableName,
        value: value,
      });
    }

    private send(data: any) {
      if (!this.ws) throw new Error('not connected');
      this.ws.send(JSON.stringify(data));
    }

    private getVariable(name: string): string {
      return this.stage.vars[name] + '';
    }

    private setVariable(name: string, value: string): void {
      this.stage.vars[name] = value;
    }

    private connect() {
      if (this.ws !== null) {
        // already connected
        return;
      }
      this.ws = new WebSocket(this.host);
      this.ws.onopen = () => {
        this.send({
          kind: 'handshake',
          id: this.id,
          username: 'player' + Math.random().toString().substr(4, 7),
          variables: getAllCloudVariables(this.stage),
        });
      };
      this.ws.onmessage = (e) => {
        try {
          // Each line of the message is treated as a separate message.
          const lines = e.data.split('\n');
          for (const line of lines) {
            const data = JSON.parse(line);
            this.handleMessage(data);
          }
        } catch (e) {
          console.warn('error parsing cloud server message', e.data, e);
          return;
        }
      };
      this.ws.onclose = (e) => {
        console.warn('ws closed', e);
      };
      this.ws.onerror = (e) => {
        console.warn('ws error', e);
      };
    }

    private handleMessage(data: unknown) {
      if (!isCloudSetMessage(data)) {
        return;
      }
      const { var: variableName, value } = data;
      if (this.stage.cloudVariables.indexOf(variableName) === -1) {
        throw new Error('invalid variable name');
      }
      this.setVariable(variableName, value);
    }

    private startInterval() {
      if (this.interval !== null) {
        // already running
        return;
      }
      this.connect();
      this.interval = setInterval(this.update, UPDATE_INTERVAL);
    }

    private stopInterval() {
      if (this.interval !== null) {
        clearInterval(this.interval);
        this.interval = null;
      }
    }

    onstart() {
      this.startInterval();
    }

    onpause() {
      this.stopInterval();
    }

    destroy() {
      this.stopInterval();
      if (this.ws) {
        this.ws.close();
      }
    }
  }

  export class LocalStorageCloudHandler extends P.ext.Extension implements CloudHandler {
    private storageKey: string;

    // In some browser configurations, localStorage does not exist or accessing it results in an error.
    // To accommodate these scenarios, all localStorage operations MUST be wrapped in a try/catch

    constructor(stage: P.core.Stage, id: string) {
      super(stage);
      this.storageKey = 'cloud-data:' + id;
      this.load();
      this.save = this.save.bind(this);
    }

    variableChanged(name: string): void {
      // TODO: don't save immediately, that's probably bad for performance
      this.save();
    }

    private load() {
      try {
        const savedData = localStorage.getItem(this.storageKey);
        if (savedData === null) {
          // no saved data, that's fine, ignore
          return;
        }
        const parsedData = JSON.parse(savedData);
        for (const key of Object.keys(parsedData)) {
          if (this.stage.cloudVariables.indexOf(key) > -1) {
            this.stage.vars[key] = parsedData[key];
          }
        }
      } catch (e) {
        console.warn('cannot read from localStorage', e);
      }
    }

    private save() {
      try {
        localStorage.setItem(this.storageKey, JSON.stringify(getAllCloudVariables(this.stage)));
      } catch (e) {
        console.warn('cannot save to localStorage', e);
      }
    }
  }
}
