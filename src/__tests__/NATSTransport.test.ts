import { ConnectionOptions } from 'nats';

import { Anomaly } from '../errors';
import { MessageConnection } from '../MessageConnection';
import { NATSTransport } from '../transports/NATSTransport';

const isCCI = process.env['CCI'] === '1';

const wait = (millis = 0): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, millis);
  });

describe('NATSTransport', (): void => {
  let clientConnection: MessageConnection<string | undefined, string | undefined>;
  let serverConnection: MessageConnection<string | undefined, string | undefined>;
  let clientObjectConnection: MessageConnection<object, object>;
  let serverObjectConnection: MessageConnection<object, object>;
  let monitorTransport: NATSTransport<string, string>;

  beforeAll(async (): Promise<void> => {
    const config: ConnectionOptions = { servers: [`nats://localhost:${isCCI ? 4222 : 4225}`] };
    const monitorUrl = `http://localhost:${isCCI ? 8222 : 8225}`;
    const signSalt = String(Date.now());

    clientConnection = new MessageConnection<string | undefined, string | undefined>(
      await NATSTransport.create({ ...config, name: 'client' }, { publishSubject: 's1', subscriptions: ['s2'] }),
      { signSalt },
    );
    serverConnection = new MessageConnection<string | undefined, string | undefined>(
      await NATSTransport.create({ ...config, name: 'server' }, { publishSubject: 's2', subscriptions: ['s1'] }),
      { signSalt },
    );

    clientObjectConnection = new MessageConnection<object, object>(
      await NATSTransport.create(
        { ...config, name: 'objectclient' },
        { publishSubject: 'so1', subscriptions: ['so2'] },
      ),
      { signSalt },
    );
    serverObjectConnection = new MessageConnection<object, object>(
      await NATSTransport.create(
        { ...config, name: 'objectserver' },
        { publishSubject: 'so2', subscriptions: ['so1'] },
      ),
      { signSalt },
    );

    monitorTransport = await NATSTransport.create(
      { ...config, monitorUrl, name: 'monitor' },
      { publishSubject: 's3', subscriptions: ['s3'] },
    );
  });

  afterAll((): void => {
    clientConnection.transport.close();
    serverConnection.transport.close();
  });

  describe('connecting', () => {
    it('should throw an error if connection fails (maxConnectAttempts: 1)', async () => {
      try {
        await NATSTransport.create(
          { servers: ['nats://localhost:4224'], maxConnectAttempts: 1 },
          { publishSubject: 'subject', subscriptions: [] },
        );
        fail('should have thrown');
      } catch (err) {
        // do nothing
      }
    });
  });

  describe('requests with multiple responses', (): void => {
    it('should handle multiple responses with an async iterator', async (): Promise<void> => {
      serverConnection.onReceive = async (message): Promise<AsyncIterableIterator<string>> =>
        (async function* (): AsyncIterableIterator<string> {
          expect(message).toBe('knock knock');

          yield "who's";
          yield 'there';
          yield '?';
        })();

      const resps1 = [];
      for await (const resp of await clientConnection.requestMulti('knock knock')) {
        resps1.push(resp);
      }

      expect(resps1).toEqual(["who's", 'there', '?']);

      const resps2 = [];
      for await (const resp of await clientConnection.requestMulti('knock knock')) {
        resps2.push(resp);
      }

      expect(resps2).toEqual(["who's", 'there', '?']);
    });

    it('should handle a single returned response with an iterator', async (): Promise<void> => {
      serverConnection.onReceive = async (message): Promise<string> => {
        return `you said ${message}`;
      };

      const resps1 = [];
      for await (const resp of await clientConnection.requestMulti('hello')) {
        resps1.push(resp);
      }

      expect(resps1).toEqual(['you said hello']);
    });
  });

  describe('requests with a single response', (): void => {
    it('should handle a single returned response', async (): Promise<void> => {
      serverConnection.onReceive = async (message): Promise<string> => {
        return `you said ${message}`;
      };

      const resp = await clientConnection.requestOne('hello');

      expect(resp).toEqual('you said hello');
    });

    it('should return the first response if multiple are provided', async (): Promise<void> => {
      serverConnection.onReceive = async (message): Promise<AsyncIterableIterator<string | undefined>> =>
        (async function* (): AsyncIterableIterator<string | undefined> {
          yield 'hey';
          yield 'there';
          yield message;
        })();

      const resp = await clientConnection.requestOne('hello');

      expect(resp).toEqual('hey');
    });
  });

  describe('one-way send (push)', (): void => {
    it('should handle pushes in both directions', async (): Promise<void> => {
      const serverReceive = jest.fn();
      const clientReceive = jest.fn();

      serverConnection.onReceive = async (message): Promise<undefined> => {
        serverReceive(message);
        return undefined;
      };

      clientConnection.onReceive = async (message): Promise<undefined> => {
        clientReceive(message);
        return undefined;
      };

      await Promise.all([clientConnection.send('one way'), serverConnection.send('or another')]);

      await wait(100);

      expect(serverReceive).toHaveBeenCalledWith('one way');
      expect(clientReceive).toHaveBeenCalledWith('or another');
    });
  });

  describe('handling errors', (): void => {
    it('should handle internal errors', async (): Promise<void> => {
      serverConnection.onReceive = async (message): Promise<undefined> => {
        throw new Error(`Error: ${message}`);
      };

      try {
        await clientConnection.requestOne('hello');
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toEqual('Error: hello');
      }
    });

    it('should handle anomalies', async (): Promise<void> => {
      serverConnection.onReceive = async (message): Promise<undefined> => {
        throw new Anomaly(`Anomaly: ${message}`, { foo: 'bar' });
      };

      try {
        await clientConnection.requestOne('hello');
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(Anomaly);
        expect((err as Anomaly).message).toEqual('Anomaly: hello');
        expect((err as Anomaly).info).toEqual({ foo: 'bar' });
      }
    });
  });

  describe('chunking', () => {
    it('should handle messages that are larger than the max payload size', async (): Promise<void> => {
      const SIZE = 5000000;
      const buf = Buffer.alloc(SIZE, 'a');

      let i = 0;
      while (i < SIZE) {
        buf[i] = 97 + Math.round(26 * Math.random());
        i += Math.round(Math.random() * 1000);
      }

      const bigRandomString = buf.toString();

      serverConnection.onReceive = async (): Promise<string> => {
        return bigRandomString;
      };

      const resp = await clientConnection.requestOne('hello');

      expect(resp).toEqual(bigRandomString);
    });
  });

  describe('monitoring', () => {
    it('should return the list of connections', async () => {
      const conns = await monitorTransport.getConnections();
      const names = new Set(conns.map(c => c.name));
      expect(names.has('client')).toBeTruthy();
      expect(names.has('server')).toBeTruthy();
      expect(names.has('monitor')).toBeTruthy();
    });
  });

  describe('serialization/unserialization', () => {
    it('should correctly pass a date object', async (): Promise<void> => {
      const now = new Date();

      serverObjectConnection.onReceive = async (message): Promise<object> => {
        const { date } = message as { date: Date };
        date.setSeconds(date.getSeconds() + 1);
        return { date };
      };

      const resp = await clientObjectConnection.requestOne({ date: now });

      const { date } = resp as { date: Date };

      expect(date.getTime()).toEqual(now.getTime() + 1000);
    });
  });
});
