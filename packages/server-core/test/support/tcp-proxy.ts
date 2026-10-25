import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';

export interface TcpProxy {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Forwards raw TCP to `target`. HTTP requests keep the Host header the client
 * sent, which lets a test play the reverse proxy in front of object storage
 * (S3_PUBLIC_ENDPOINT on another host/port than S3_ENDPOINT).
 */
export async function startTcpProxy(targetHost: string, targetPort: number): Promise<TcpProxy> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = createConnection({ host: targetHost, port: targetPort });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}
