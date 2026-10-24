// @gcu/wireframe — browser-safe entry (no node: imports). Node adds src/node.js (nodeBacking).
export { openWfr, MIMETYPE, FORMAT_VERSION, SPEC_URL } from './wfr.js';
export { writeWfr, createWfrWriter, attrType } from './write.js';
export { createScratch, opfsBacking, clearOpfsScratch } from './scratch.js';
export { checkTopology } from './topology.js';
export { linesFromPolylines, chainPolylines } from './polylines.js';
export { openZip, createZipWriter, bytesSource, blobSource, crc32 } from './zip.js';
export { parseFooter, decodeChunk } from './parquet.js';
export { writeParquet, ParquetStream } from './parquet-write.js';
