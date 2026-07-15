declare module 'hdb' {
  interface ConnectionOptions {
    host: string
    port: number
    database: string
    user: string
    password: string
  }

  interface Connection {
    on(event: string, cb: (err: any) => void): void
    connect(cb: (err: any) => void): void
    exec(sql: string, cb: (err: any, rows: any[]) => void): void
    disconnect(): void
  }

  export function createConnection(opts: ConnectionOptions): Connection
}
