// Протокол Native Messaging: каждое сообщение — 4 байта длины (little-endian) и JSON в UTF-8.
// stdout занят только этими кадрами: любой посторонний вывод ломает связь с браузером, поэтому логи — в stderr.

import type { Readable, Writable } from "node:stream";

/** Chrome принимает от помощника сообщения не больше 1 МБ. */
export const MAX_OUTGOING_BYTES = 1024 * 1024;

export function encode(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_OUTGOING_BYTES) throw new Error(`Сообщение больше 1 МБ: ${body.length} байт`);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Разбирает поток кадров; неполные кадры ждут следующих данных. */
export function createDecoder(onMessage: (message: unknown) => void): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length).toString("utf8");
      buffer = buffer.subarray(4 + length);
      try {
        onMessage(JSON.parse(body));
      } catch {
        // Некорректный JSON от браузера — пропускаем кадр.
      }
    }
  };
}

export function connect(input: Readable, output: Writable, onMessage: (message: unknown) => void, onClose: () => void): (message: unknown) => void {
  input.on("data", createDecoder(onMessage));
  input.on("end", onClose);
  input.on("close", onClose);
  return (message) => {
    output.write(encode(message));
  };
}
