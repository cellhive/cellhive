import { once } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

/**
 * A tiny in-process SMTP server for the E2E specs of email settings (T526):
 * plain TCP (the API runs with `SMTP_ALLOW_INSECURE=true` and STARTTLS is
 * not offered), `AUTH PLAIN` against fixed credentials (`535 5.7.8`
 * otherwise), every message accepted with `250 2.0.0` and kept in memory.
 * No dependency: `smtp-server` is a dev dependency of the API only.
 */

export interface CapturedMail {
  readonly from: string;
  readonly to: readonly string[];
  readonly raw: string;
}

export interface FakeSmtp {
  readonly port: number;
  readonly messages: CapturedMail[];
  close(): Promise<void>;
}

const CRLF = '\r\n';

function serve(socket: Socket, credentials: { user: string; pass: string }, sink: CapturedMail[]) {
  let buffer = '';
  let data: string[] | null = null;
  let from = '';
  let to: string[] = [];
  const reply = (line: string) => {
    socket.write(`${line}${CRLF}`);
  };
  const command = (line: string) => {
    const verb = line.split(' ')[0]?.toUpperCase() ?? '';
    switch (verb) {
      case 'EHLO':
      case 'HELO':
        socket.write(`250-fake-smtp${CRLF}250-AUTH PLAIN${CRLF}250 8BITMIME${CRLF}`);
        return;
      case 'AUTH': {
        const [, mechanism = '', initial = ''] = line.split(' ');
        if (mechanism.toUpperCase() !== 'PLAIN' || initial === '') {
          reply('504 5.5.4 Unsupported authentication');
          return;
        }
        const [, user = '', pass = ''] = Buffer.from(initial, 'base64')
          .toString('utf8')
          .split('\0');
        reply(
          user === credentials.user && pass === credentials.pass
            ? '235 2.7.0 Authentication successful'
            : '535 5.7.8 Authentication credentials invalid',
        );
        return;
      }
      case 'MAIL':
        from = /<([^>]*)>/u.exec(line)?.[1] ?? '';
        to = [];
        reply('250 2.1.0 OK');
        return;
      case 'RCPT':
        to.push(/<([^>]*)>/u.exec(line)?.[1] ?? '');
        reply('250 2.1.5 OK');
        return;
      case 'DATA':
        data = [];
        reply('354 End data with <CR><LF>.<CR><LF>');
        return;
      case 'QUIT':
        reply('221 2.0.0 Bye');
        socket.end();
        return;
      case 'RSET':
      case 'NOOP':
        reply('250 2.0.0 OK');
        return;
      default:
        reply('502 5.5.2 Command not implemented');
    }
  };
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let end = buffer.indexOf(CRLF);
    while (end >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + CRLF.length);
      if (data === null) {
        command(line);
      } else if (line === '.') {
        sink.push({ from, to, raw: data.join(CRLF) });
        data = null;
        reply('250 2.0.0 OK queued');
      } else {
        data.push(line.startsWith('..') ? line.slice(1) : line);
      }
      end = buffer.indexOf(CRLF);
    }
  });
  socket.on('error', () => undefined);
  reply('220 fake-smtp ESMTP');
}

export async function startFakeSmtp(credentials: {
  user: string;
  pass: string;
}): Promise<FakeSmtp> {
  const messages: CapturedMail[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    serve(socket, credentials, messages);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    port,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}
