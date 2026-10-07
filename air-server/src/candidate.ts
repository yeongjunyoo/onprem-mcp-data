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

// Gate2 — canonical retrieval-candidate contract (frozen before graph code).
//
// Every retrieval branch (SQL / vector / graph) emits Candidates that share ONE
// canonical identity space. RRF then fuses by `canonicalKey`, so the SAME real
// entity surfaced by multiple branches accumulates agreement (named sources)
// instead of being three unrelated rows. This is what turns "three lists merged"
// into a genuine 3-way agreement signal.
//
// Canonical key scheme (stable across branches via bench.entity_links):
//   entity:<type>#<entity_id>   e.g. "entity:product#12", "entity:category#3", "entity:policy#1001"
//   row:<table>#<pk>            for SQL rows with no entity mapping (e.g. "row:orders#42")
//   documents#<id>              for document chunks with no entity mapping
//
// sourceKey is the per-branch positional key (audit only); canonicalKey drives fusion.

export type CandidateSource = "sql" | "vector" | "graph";

export interface Candidate {
  /** Cross-source identity used for RRF fusion. */
  canonicalKey: string;
  /** Per-branch positional key (e.g. "sql#0", "vector#3", "graph#1"); audit only. */
  sourceKey: string;
  /** Which retrieval branch produced this candidate. */
  source: CandidateSource;
  /** Rendered context text for the curator / LLM. */
  text: string;
  /** Human-readable origin for the audit log. */
  provenance: string;
}

/** Canonical key for an entity (the bridge target in bench.entity_links). */
export function entityKey(type: string, entityId: number): string {
  return `entity:${type}#${entityId}`;
}

/** Canonical key for a raw SQL row that has no entity mapping. */
export function rowKey(table: string, pk: number | string): string {
  return `row:${table}#${pk}`;
}

/** Canonical key for a document chunk that has no entity mapping. */
export function documentKey(id: number | string): string {
  return `documents#${id}`;
}
