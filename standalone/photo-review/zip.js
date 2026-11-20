const endSignature = 0x06054b50;
const indexSignature = 0x02014b50;
const entrySignature = 0x04034b50;
const maxIndexBytes = 32 * 1024 * 1024;
const textDecoder = new TextDecoder('utf-8', {fatal:true});

async function view(blob, start, length) {
  if (start < 0 || start + length > blob.size) throw new Error('ZIP 文件不完整。');
  return new DataView(await blob.slice(start,start+length).arrayBuffer());
}

export async function openZip(blob) {
  const start = Math.max(0,blob.size - 65557);
  const tail = await view(blob,start,blob.size - start);
  let end = tail.byteLength - 22;
  while (end >= 0 && (tail.getUint32(end,true) !== endSignature ||
    end + 22 + tail.getUint16(end+20,true) !== tail.byteLength)) end--;
  if (end < 0) throw new Error('无法读取 ZIP 文件。');
  const count = tail.getUint16(end+10,true);
  const indexSize = tail.getUint32(end+12,true);
  const indexStart = tail.getUint32(end+16,true);
  if (tail.getUint16(end+4,true) || tail.getUint16(end+6,true) ||
    tail.getUint16(end+8,true) !== count || count === 65535 || indexSize > maxIndexBytes ||
    indexStart + indexSize > start + end) throw new Error('请选择普通的单卷 ZIP 文件。');
  const index = await view(blob,indexStart,indexSize);
  const entries = new Map();
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > index.byteLength || index.getUint32(cursor,true) !== indexSignature)
      throw new Error('ZIP 文件目录不完整。');
    const flags = index.getUint16(cursor+8,true);
    const method = index.getUint16(cursor+10,true);
    const packed = index.getUint32(cursor+20,true);
    const size = index.getUint32(cursor+24,true);
    const nameBytes = index.getUint16(cursor+28,true);
    const extra = index.getUint16(cursor+30,true);
    const comment = index.getUint16(cursor+32,true);
    const offset = index.getUint32(cursor+42,true);
    const next = cursor+46+nameBytes+extra+comment;
    if (next > index.byteLength) throw new Error('ZIP 文件目录不完整。');
    const name = textDecoder.decode(new Uint8Array(index.buffer,cursor+46,nameBytes));
    if (entries.has(name)) throw new Error('ZIP 内有重复文件路径。');
    entries.set(name,{flags,method,packed,size,offset});
    cursor = next;
  }

  async function read(name,limit) {
    const entry = entries.get(name);
    if (!entry || entry.size > limit || entry.packed > limit + 65536)
      throw new Error('文件缺失或超出大小限制：' + name.split('/').at(-1));
    if (entry.flags & 1 || ![0,8].includes(entry.method))
      throw new Error('请选择未加密、使用标准压缩的 ZIP 文件。');
    const header = await view(blob,entry.offset,30);
    if (header.getUint32(0,true) !== entrySignature || header.getUint16(8,true) !== entry.method)
      throw new Error('ZIP 内有损坏的文件。');
    const offset = entry.offset + 30 + header.getUint16(26,true) + header.getUint16(28,true);
    if (offset + entry.packed > indexStart) throw new Error('ZIP 内有不完整的文件。');
    const file = blob.slice(offset,offset+entry.packed);
    if (entry.method === 0) {
      if (file.size !== entry.size) throw new Error('ZIP 文件大小与目录不符。');
      return file;
    }
    const inflater = new DecompressionStream('deflate-raw');
    const reader = file.stream().pipeThrough(inflater).getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const {value,done} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > entry.size) throw new Error('ZIP 文件大小与目录不符。');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    if (size !== entry.size) throw new Error('ZIP 文件大小与目录不符。');
    return new Blob(chunks);
  }
  return {names:[...entries.keys()], has:name=>entries.has(name), read};
}
