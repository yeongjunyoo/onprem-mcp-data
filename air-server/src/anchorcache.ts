// Copyright 2026 Yeongjun Yoo
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// 시맨틱 앵커 벡터 캐시. 앵커가 423문장이라 기동마다 bge-m3 로 다시 임베딩하면 12~16초가 든다(175문장 때는 약 5초).
// MCP 클라이언트가 도구를 부를 때마다 서버를 새로 띄우기도 하므로(Inspector CLI) 그 시간이 호출마다 붙는다.
// 임베더 이름과 앵커 문장 목록이 같으면 지난번 벡터를 파일에서 읽는다. 같은 모델 이름으로 가중치가 바뀌었을 수 있으므로
// 첫 앵커 하나는 매번 새로 임베딩해 저장된 벡터와 견주고, 다르면 전부 다시 임베딩한다.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Embedder } from "./embedder.js";

export const ANCHOR_CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".cache");

/** 저장된 첫 앵커 벡터와 새로 임베딩한 벡터의 코사인이 이 값 이상이면 같은 모델로 본다. GPU 부동소수 잡음은 1e-6 수준이다. */
const SAME_MODEL_COSINE = 0.9999;

export type AnchorCacheState = "hit" | "miss" | "stale" | "off";

export interface EmbeddedAnchors {
  vecs: number[][];
  cache: AnchorCacheState;
  /** 캐시를 쓰지 못했을 때만. 벡터는 그래도 쓴다. */
  note?: string;
}

function cosine(a: number[], b: number[]): number {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

/** 파일: 첫 줄은 JSON 머리(임베더, 개수, 차원), 그 뒤는 float64 리틀 엔디언 벡터를 이어 붙인 것. */
function encode(embedder: string, vecs: number[][]): Buffer {
  const dim = vecs[0]?.length ?? 0;
  const head = Buffer.from(JSON.stringify({ embedder, count: vecs.length, dim }) + "\n", "utf8");
  const body = Buffer.alloc(vecs.length * dim * 8);
  vecs.forEach((v, i) => v.forEach((x, j) => body.writeDoubleLE(x, (i * dim + j) * 8)));
  return Buffer.concat([head, body]);
}

function decode(buf: Buffer, embedder: string, count: number): number[][] | null {
  const nl = buf.indexOf(0x0a);
  if (nl < 0) return null;
  const head = JSON.parse(buf.subarray(0, nl).toString("utf8")) as { embedder: string; count: number; dim: number };
  if (head.embedder !== embedder || head.count !== count || !(head.dim > 0)) return null;
  const body = buf.subarray(nl + 1);
  if (body.length !== count * head.dim * 8) return null;
  return Array.from({ length: count }, (_, i) => Array.from({ length: head.dim }, (_, j) => body.readDoubleLE((i * head.dim + j) * 8)));
}

/** 앵커 문장들을 임베딩한다. ollama 임베더만 캐시를 쓴다(해시 임베더와 테스트 임베더는 그대로 임베딩). */
export async function embedAnchors(embedder: Embedder, texts: readonly string[], dir = ANCHOR_CACHE_DIR): Promise<EmbeddedAnchors> {
  const all = async () => {
    const vecs: number[][] = [];
    for (const t of texts) vecs.push(await embedder.embed(t));
    return vecs;
  };
  if (!embedder.name.startsWith("ollama:") || texts.length === 0) return { vecs: await all(), cache: "off" };

  // 프로필마다 임베더가 다르다(companyx 는 768 절단, smoke 는 1024). 이름에 임베더를 넣어 서로의 캐시를 지우지 않게 한다.
  const who = createHash("sha256").update(embedder.name).digest("hex").slice(0, 8);
  const key = createHash("sha256").update(embedder.name + "\0" + texts.join("\0")).digest("hex").slice(0, 16);
  const file = join(dir, `anchors-${who}-${key}.bin`);
  let cache: AnchorCacheState = "miss";
  try {
    const cached = decode(await readFile(file), embedder.name, texts.length);
    if (cached) {
      if (cosine(await embedder.embed(texts[0]), cached[0]) >= SAME_MODEL_COSINE) return { vecs: cached, cache: "hit" };
      cache = "stale";
    }
  } catch {
    // 파일이 없거나 읽지 못하면 새로 임베딩한다.
  }

  const vecs = await all();
  try {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, encode(embedder.name, vecs));
    await rename(tmp, file);
    // 같은 임베더의 앵커가 바뀌어 남은 지난 캐시는 다시 쓸 일이 없다. 다른 임베더(다른 프로필)의 캐시는 그대로 둔다.
    // 2026-10-20 리허설: 임베더를 가리지 않고 지웠더니 통합 테스트(smoke)와 서버(companyx)가 번갈아 서로의 캐시를 지웠다.
    const stale = new RegExp(`^anchors-(${who}-[0-9a-f]{16}|[0-9a-f]{16})\\.bin$`);
    for (const f of await readdir(dir)) {
      if (stale.test(f) && join(dir, f) !== file) await rm(join(dir, f), { force: true });
    }
    return { vecs, cache };
  } catch (e) {
    // 폴백: 캐시만 못 쓴 것이라 벡터는 그대로 쓴다. 이유는 note 로 돌려주고 기동 로그(index.ts)가 찍는다.
    return { vecs, cache, note: `앵커 캐시를 쓰지 못했다(${String((e as Error).message ?? e).slice(0, 120)}). 다음 기동도 새로 임베딩한다` };
  }
}
