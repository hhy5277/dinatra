// Copyright 2018-2019 the Deno authors. All rights reserved. MIT license.

import { BufReader, BufWriter } from 'https://deno.land/std@v0.3.2/io/bufio.ts';
import { TextProtoReader } from 'https://deno.land/std@v0.3.2/textproto/mod.ts';
import { STATUS_TEXT } from 'https://deno.land/std@v0.3.2/http/http_status.ts';
import { assert } from 'https://deno.land/std@v0.3.2/testing/asserts.ts';
import {
  defer,
  Deferred,
} from 'https://deno.land/std@v0.2.11/util/deferred.ts';
import { BodyReader, ChunkedBodyReader } from './readers.ts';
import { encode } from 'https://deno.land/std@v0.3.2/strings/strings.ts';

/** basic handler for http request */
export type HttpHandler = (req: ServerRequest, res: ServerResponder) => unknown;

export type ServerRequest = {
  /** request path with queries. always begin with / */
  url: string;
  /** HTTP method */
  method: string;
  /** requested protocol. like HTTP/1.1 */
  proto: string;
  /** HTTP Headers */
  headers: Headers;
  /** matched result for path pattern  */
  match: RegExpMatchArray;
  /** body stream. body with "transfer-encoding: chunked" will automatically be combined into original data */
  body: Deno.Reader;
};

/** basic responder for http response */
export interface ServerResponder {
  respond(response: ServerResponse): Promise<void>;

  respondJson(obj: any, headers?: Headers): Promise<void>;

  respondText(text: string, headers?: Headers): Promise<void>;

  readonly isResponded: boolean;
}

export interface ServerResponse {
  /**
   * HTTP status code
   * @default 200 */
  status?: number;
  headers?: Headers;
  body?: Uint8Array | Deno.Reader;
}

interface ServeEnv {
  reqQueue: { req: ServerRequest; conn: Deno.Conn }[];
  serveDeferred: Deferred;
}

/** Continuously read more requests from Deno.Conn until EOF
 * Calls maybeHandleReq.
 * TODO: make them async function after this change is done
 * https://github.com/tc39/ecma262/pull/1250
 * See https://v8.dev/blog/fast-async
 */
function serveConn(env: ServeEnv, conn: Deno.Conn) {
  readRequest(conn)
    .then(maybeHandleReq.bind(null, env, conn))
    .catch(e => {
      conn.close();
    });
}

function maybeHandleReq(env: ServeEnv, conn: Deno.Conn, req: ServerRequest) {
  env.reqQueue.push({ conn, req }); // push req to queue
  env.serveDeferred.resolve(); // signal while loop to process it
}

/**
 * iterate new http request asynchronously
 * @param addr listening address. like 127.0.0.1:80
 * @param cancel deferred object for cancellation of serving
 * */
export async function* serve(
  addr: string,
  cancel: Deferred = defer()
): AsyncIterableIterator<{ req: ServerRequest; res: ServerResponder }> {
  const listener = Deno.listen('tcp', addr);
  const env: ServeEnv = {
    reqQueue: [], // in case multiple promises are ready
    serveDeferred: defer(),
  };
  // Routine that keeps calling accept
  const acceptRoutine = () => {
    const handleConn = (conn: Deno.Conn) => {
      serveConn(env, conn); // don't block
      scheduleAccept(); // schedule next accept
    };
    const scheduleAccept = () => {
      Promise.race([cancel.promise, listener.accept().then(handleConn)]);
    };
    scheduleAccept();
  };
  acceptRoutine();
  while (true) {
    // do race between accept, serveDeferred and cancel
    await Promise.race([env.serveDeferred.promise, cancel.promise]);
    // cancellation deferred resolved
    if (cancel.handled) {
      break;
    }
    // next serve deferred
    env.serveDeferred = defer();
    const queueToProcess = env.reqQueue;
    env.reqQueue = [];
    for (const { req, conn } of queueToProcess) {
      if (req) {
        const res = createResponder(conn);
        yield { req, res };
      }
      serveConn(env, conn);
    }
  }
  listener.close();
}

export async function listenAndServe(addr: string, handler: HttpHandler) {
  const server = serve(addr);

  for await (const { req, res } of server) {
    await handler(req, res);
  }
}

export interface HttpServer {
  handle(pattern: string | RegExp, handler: HttpHandler);

  listen(addr: string, cancel?: Deferred): Promise<void>;
}

/** create HttpServer object */
export function createServer(): HttpServer {
  return new HttpServerImpl();
}

/** create ServerResponder object */
export function createResponder(w: Deno.Writer): ServerResponder {
  return new ServerResponderImpl(w);
}

class HttpServerImpl implements HttpServer {
  private handlers: { pattern: string | RegExp; handler: HttpHandler }[] = [];

  handle(pattern: string | RegExp, handler: HttpHandler) {
    this.handlers.push({ pattern, handler });
  }

  async listen(addr: string, cancel: Deferred = defer()) {
    for await (const { req, res } of serve(addr, cancel)) {
      let { pathname } = new URL(req.url, addr);
      const { index, match } = findLongestAndNearestMatch(
        pathname,
        this.handlers.map(v => v.pattern)
      );
      req.match = match;
      if (index > -1) {
        const { handler } = this.handlers[index];
        await handler(req, res);
        if (!res.isResponded) {
          await res.respond({
            status: 500,
            body: encode('Not Responded'),
          });
        }
      } else {
        await res.respond({
          status: 404,
          body: encode('Not Found'),
        });
      }
    }
  }
}

/**
 * Find the match that appeared in the nearest position to the beginning of word.
 * If positions are same, the longest one will be picked.
 * Return -1 and null if no match found.
 * */
export function findLongestAndNearestMatch(
  pathname: string,
  patterns: (string | RegExp)[]
): { index: number; match: RegExpMatchArray } {
  let lastMatchIndex = pathname.length;
  let lastMatchLength = 0;
  let match: RegExpMatchArray = null;
  let index = -1;
  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i];
    const m = pathname.match(pattern);
    if (!m) continue;
    if (
      m.index < lastMatchIndex ||
      (m.index === lastMatchIndex && m[0].length > lastMatchLength)
    ) {
      index = i;
      match = m;
      lastMatchIndex = m.index;
      lastMatchLength = m[0].length;
    }
  }
  return { index, match };
}

class ServerResponderImpl implements ServerResponder {
  constructor(private w: Deno.Writer) {}

  private _responded: boolean = false;

  get isResponded() {
    return this._responded;
  }

  private checkIfResponded() {
    if (this.isResponded) {
      throw new Error('http: already responded');
    }
  }

  respond(response: ServerResponse): Promise<void> {
    this.checkIfResponded();
    this._responded = true;
    return writeResponse(this.w, response);
  }

  respondJson(obj: any, headers: Headers = new Headers()): Promise<void> {
    const body = encode(JSON.stringify(obj));
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return this.respond({
      status: 200,
      body,
      headers,
    });
  }

  respondText(text: string, headers: Headers = new Headers()): Promise<void> {
    const body = encode(text);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'text/plain');
    }
    return this.respond({
      status: 200,
      headers,
      body,
    });
  }
}

export function setContentLength(r: ServerResponse): void {
  if (!r.headers) {
    r.headers = new Headers();
  }

  if (r.body) {
    if (!r.headers.has('content-length')) {
      if (r.body instanceof Uint8Array) {
        const bodyLength = r.body.byteLength;
        r.headers.append('Content-Length', bodyLength.toString());
      } else {
        r.headers.append('Transfer-Encoding', 'chunked');
      }
    }
  }
}

function bufWriter(w: Deno.Writer): BufWriter {
  if (w instanceof BufWriter) {
    return w;
  } else {
    return new BufWriter(w);
  }
}

export async function writeResponse(
  w: Deno.Writer,
  r: ServerResponse
): Promise<void> {
  const protoMajor = 1;
  const protoMinor = 1;
  const statusCode = r.status || 200;
  const statusText = STATUS_TEXT.get(statusCode);
  const writer = bufWriter(w);
  if (!statusText) {
    throw Error('bad status code');
  }

  let out = `HTTP/${protoMajor}.${protoMinor} ${statusCode} ${statusText}\r\n`;

  setContentLength(r);

  if (r.headers) {
    for (const [key, value] of r.headers) {
      out += `${key}: ${value}\r\n`;
    }
  }
  out += '\r\n';

  const header = new TextEncoder().encode(out);
  let n = await writer.write(header);
  assert(header.byteLength == n);

  if (r.body) {
    if (r.body instanceof Uint8Array) {
      n = await writer.write(r.body);
      assert(r.body.byteLength == n);
    } else {
      if (r.headers.has('content-length')) {
        const bodyLength = parseInt(r.headers.get('content-length'));
        const n = await Deno.copy(writer, r.body);
        assert(n == bodyLength);
      } else {
        await writeChunkedBody(writer, r.body);
      }
    }
  }
  await writer.flush();
}

async function writeChunkedBody(w: Deno.Writer, r: Deno.Reader) {
  const writer = bufWriter(w);
  const encoder = new TextEncoder();

  for await (const chunk of Deno.toAsyncIterator(r)) {
    const start = encoder.encode(`${chunk.byteLength.toString(16)}\r\n`);
    const end = encoder.encode('\r\n');
    await writer.write(start);
    await writer.write(chunk);
    await writer.write(end);
  }

  const endChunk = encoder.encode('0\r\n\r\n');
  await writer.write(endChunk);
}

export async function readRequest(conn: Deno.Reader): Promise<ServerRequest> {
  const bufr = new BufReader(conn);
  const tp = new TextProtoReader(bufr!);

  // First line: GET /index.html HTTP/1.0
  const [line, lineErr] = await tp.readLine();
  if (lineErr) {
    throw lineErr;
  }
  const [method, url, proto] = line.split(' ', 3);
  const [headers, headersErr] = await tp.readMIMEHeader();
  if (headersErr) {
    throw headersErr;
  }
  const contentLength = headers.get('content-length');
  const body =
    headers.get('transfer-encoding') === 'chunked'
      ? new ChunkedBodyReader(bufr)
      : new BodyReader(bufr, parseInt(contentLength));
  return {
    method,
    url,
    proto,
    headers,
    body,
    match: null,
  };
}

export async function readResponse(conn: Deno.Reader): Promise<ServerResponse> {
  const bufr = new BufReader(conn);
  const tp = new TextProtoReader(bufr!);
  // First line: HTTP/1,1 200 OK
  const [line, lineErr] = await tp.readLine();
  if (lineErr) {
    throw lineErr;
  }
  const [proto, status, statusText] = line.split(' ', 3);
  const [headers, headersErr] = await tp.readMIMEHeader();
  if (headersErr) {
    throw headersErr;
  }
  const contentLength = headers.get('content-length');
  const body =
    headers.get('transfer-encoding') === 'chunked'
      ? new ChunkedBodyReader(bufr)
      : new BodyReader(bufr, parseInt(contentLength));
  return { status: parseInt(status), headers, body };
}
