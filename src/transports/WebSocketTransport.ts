import 'ws'; // need to explicitly import this so it gets loaded as a dependency

import WebSocket from 'isomorphic-ws';

import { MessageTransport, RequestMessage, ResponseMessage } from '../MessageTransport';
import { deserialize, serialize } from '../serialize';

export class ServerWebSocketTransport<T, R> implements MessageTransport<T, R> {
  private readonly socket: WebSocket;

  public constructor(socket: WebSocket) {
    this.socket = socket;
  }

  public async send(message: RequestMessage<T> | ResponseMessage<R>): Promise<void> {
    this.socket.send(serialize(message));
  }

  public onReceive(receive: (message: RequestMessage<T> | ResponseMessage<R>) => void): void {
    this.socket.addListener('message', data => {
      receive(deserialize(data.toString()));
    });
  }

  public async close(): Promise<void> {
    return new Promise(resolve => {
      this.socket.addListener('close', resolve);
      this.socket.close();
    });
  }
}

export class ClientWebSocketTransport<T, R> implements MessageTransport<T, R> {
  public onClose?: () => void;

  private readonly url: string;
  private socket?: WebSocket;
  private onReceiveFn?: (message: RequestMessage<T> | ResponseMessage<R>) => void;

  public constructor(url: string) {
    this.url = url;
  }

  public async send(message: RequestMessage<T> | ResponseMessage<R>): Promise<void> {
    await this.connect();

    if (this.socket) {
      this.socket.send(serialize(message));
    }
  }

  public onReceive(onReceiveFn: (message: RequestMessage<T> | ResponseMessage<R>) => void): void {
    this.onReceiveFn = onReceiveFn;
  }

  public async close(): Promise<void> {
    return new Promise(resolve => {
      if (this.socket) {
        this.socket.addEventListener('close', resolve);
        this.socket.close(1000);
      } else {
        resolve();
      }
    });
  }

  public isOpen(): boolean {
    return this.socket !== undefined && this.socket.readyState === WebSocket.OPEN;
  }

  private async connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    } else if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
      return new Promise<void>(resolve => {
        this.socket && this.socket.addEventListener('open', resolve);
      });
    }
    await new Promise<void>((resolve, reject) => {
      try {
        this.socket = new WebSocket(this.url);

        this.socket.addEventListener('message', event => {
          if (this.onReceiveFn) {
            this.onReceiveFn(deserialize(event.data.toString()));
          }
        });

        this.socket.addEventListener('close', () => {
          if (this.onClose) {
            this.onClose();
          }
          this.socket = undefined;
        });

        this.socket.addEventListener('open', resolve);

        this.socket.addEventListener('error', event => {
          const errorMessage = `Socket error (${this.url}): ${event?.error?.message || 'unknown error'}`;
          reject(new Error(errorMessage));
        });
      } catch (err) {
        const errorMessage = `Error creating WebSocket (${this.url}): ${
          err instanceof Error ? err.message : String(err)
        }`;
        reject(new Error(errorMessage));
      }
    });

    if (this.socket && this.socket.readyState === WebSocket.CLOSING) {
      return new Promise((_, reject) => {
        if (this.socket) {
          this.socket.addEventListener('close', event => {
            reject(new Error(`Socket closed by server (${event.reason})`));
          });
        }
      });
    }
  }
}
