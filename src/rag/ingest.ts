import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { replaceAllChunks, type ChunkInput } from "../db";
import { chunkText } from "./chunk";
import { embed, EMBEDDING_MODEL } from "./embedder";

/**
 * Slice 6: ingestion. A script, not an endpoint — run it when the docs
 * change:  npm run ingest  (optionally: npm run ingest -- <folder>)
 *
 * Reads every .md file in the folder, chunks it, embeds all chunks in one
 * batch call, and rebuilds the chunks table from scratch.
 */
const docsDir = process.argv[2] ?? "rag-docs";

async function main(): Promise<void> {
  const files = (await readdir(docsDir)).filter((f) => f.endsWith(".md")).sort();
  if (files.length === 0) {
    console.error(`No .md files found in ${docsDir}/`);
    process.exit(1);
  }

  const chunks: ChunkInput[] = [];
  for (const file of files) {
    const text = await readFile(path.join(docsDir, file), "utf8");
    const pieces = chunkText(text);
    pieces.forEach((content, chunkIndex) => {
      chunks.push({ source: file, chunkIndex, content });
    });
    console.log(`${file}: ${pieces.length} chunk(s)`);
  }

  const result = await embed(chunks.map((c) => c.content));
  if (!result.ok) {
    console.error(`Embedding failed (${result.error.kind}): ${result.error.message}`);
    process.exit(1);
  }

  replaceAllChunks(chunks, result.value);
  console.log(
    `Stored ${chunks.length} chunks from ${files.length} file(s), embedded with ${EMBEDDING_MODEL}.`,
  );
}

void main();
