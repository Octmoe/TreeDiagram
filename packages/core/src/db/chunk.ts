/** SQLite 单次查询变量数有限，IN 查询统一分批。 */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export const SQLITE_IN_CHUNK_SIZE = 500;
