/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Mango Query Operator Metadata and Reference
 * https://docs.couchdb.org/en/stable/api/database/find.html
 */

export interface OperatorMetadata {
  name: string; // "$eq"
  label: string; // "Equals"
  description: string; // "Match exact value"
  tier: 1 | 2 | 3 | 4; // Support phase
  examples: Record<string, any>[]; // [{ status: { $eq: "active" } }]
  syntaxHelp: string; // "{ field: { $operator: value } }"
  fieldTypes: string[]; // ["string", "number", "boolean"]
}

/**
 * Tier 1: Core operators (MVP)
 * Essential for basic filtering
 */
export const TIER_1_OPERATORS: Record<string, OperatorMetadata> = {
  $eq: {
    name: "$eq",
    label: "Equals",
    description: "Match exact value",
    tier: 1,
    examples: [{ status: { $eq: "active" } }, { age: { $eq: 25 } }],
    syntaxHelp: "{ field: { $eq: value } }",
    fieldTypes: ["string", "number", "boolean", "null"],
  },
  $in: {
    name: "$in",
    label: "In Array",
    description: "Value exists in array",
    tier: 1,
    examples: [
      { status: { $in: ["active", "pending"] } },
      { region: { $in: ["US", "EU", "APAC"] } },
    ],
    syntaxHelp: "{ field: { $in: [value1, value2, ...] } }",
    fieldTypes: ["string", "number"],
  },
  $exists: {
    name: "$exists",
    label: "Exists",
    description: "Field exists or not",
    tier: 1,
    examples: [{ email: { $exists: true } }, { phone: { $exists: false } }],
    syntaxHelp: "{ field: { $exists: true/false } }",
    fieldTypes: ["any"],
  },
};

/**
 * Tier 2: Comparison operators (Phase 2)
 */
export const TIER_2_OPERATORS: Record<string, OperatorMetadata> = {
  $gt: {
    name: "$gt",
    label: "Greater Than",
    description: "Field greater than value",
    tier: 2,
    examples: [{ total: { $gt: 100 } }, { created_at: { $gt: "2026-01-01" } }],
    syntaxHelp: "{ field: { $gt: value } }",
    fieldTypes: ["number", "string"],
  },
  $gte: {
    name: "$gte",
    label: "Greater Than or Equal",
    description: "Field greater than or equal to value",
    tier: 2,
    examples: [{ score: { $gte: 80 } }, { updated_at: { $gte: "2026-01-01" } }],
    syntaxHelp: "{ field: { $gte: value } }",
    fieldTypes: ["number", "string"],
  },
  $lt: {
    name: "$lt",
    label: "Less Than",
    description: "Field less than value",
    tier: 2,
    examples: [{ price: { $lt: 50 } }, { date: { $lt: "2026-12-31" } }],
    syntaxHelp: "{ field: { $lt: value } }",
    fieldTypes: ["number", "string"],
  },
  $lte: {
    name: "$lte",
    label: "Less Than or Equal",
    description: "Field less than or equal to value",
    tier: 2,
    examples: [
      { quantity: { $lte: 10 } },
      { deadline: { $lte: "2026-12-31" } },
    ],
    syntaxHelp: "{ field: { $lte: value } }",
    fieldTypes: ["number", "string"],
  },
  $ne: {
    name: "$ne",
    label: "Not Equal",
    description: "Field not equal to value",
    tier: 2,
    examples: [{ status: { $ne: "deleted" } }, { type: { $ne: "admin" } }],
    syntaxHelp: "{ field: { $ne: value } }",
    fieldTypes: ["string", "number", "boolean"],
  },
};

/**
 * Tier 3: Advanced operators (Phase 3)
 */
export const TIER_3_OPERATORS: Record<string, OperatorMetadata> = {
  $regex: {
    name: "$regex",
    label: "Regex",
    description: "Match regular expression pattern",
    tier: 3,
    examples: [
      { email: { $regex: "^.*@example\\.com$" } },
      { code: { $regex: "^[A-Z]{3}[0-9]{3}$" } },
    ],
    syntaxHelp: "{ field: { $regex: pattern } }",
    fieldTypes: ["string"],
  },
  $type: {
    name: "$type",
    label: "Type",
    description: "Field type check",
    tier: 3,
    examples: [{ metadata: { $type: "object" } }, { tags: { $type: "array" } }],
    syntaxHelp:
      '{ field: { $type: "string|number|object|array|boolean|null" } }',
    fieldTypes: ["any"],
  },
  $size: {
    name: "$size",
    label: "Size",
    description: "Array or string length",
    tier: 3,
    examples: [{ tags: { $size: 5 } }, { name: { $size: 20 } }],
    syntaxHelp: "{ field: { $size: length } }",
    fieldTypes: ["array", "string"],
  },
  $all: {
    name: "$all",
    label: "All",
    description: "Array contains all values",
    tier: 3,
    examples: [
      { tags: { $all: ["urgent", "important"] } },
      { roles: { $all: ["admin", "user"] } },
    ],
    syntaxHelp: "{ field: { $all: [value1, value2, ...] } }",
    fieldTypes: ["array"],
  },
  $elemMatch: {
    name: "$elemMatch",
    label: "Element Match",
    description: "Array element matching condition",
    tier: 3,
    examples: [{ items: { $elemMatch: { price: { $gt: 100 } } } }],
    syntaxHelp: "{ field: { $elemMatch: { condition } } }",
    fieldTypes: ["array"],
  },
};

/**
 * Combined operators (Tier 1 + 2 for MVP support)
 */
export const SUPPORTED_OPERATORS = {
  ...TIER_1_OPERATORS,
  ...TIER_2_OPERATORS,
};

export const ALL_OPERATORS = {
  ...TIER_1_OPERATORS,
  ...TIER_2_OPERATORS,
  ...TIER_3_OPERATORS,
};

/**
 * Get operator metadata by name
 */
export function getOperatorMetadata(name: string): OperatorMetadata | null {
  return ALL_OPERATORS[name] || null;
}

/**
 * Validate if operator is supported
 */
export function isSupportedOperator(name: string): boolean {
  return name in SUPPORTED_OPERATORS;
}

/**
 * Get all supported operator names
 */
export function getSupportedOperatorNames(): string[] {
  return Object.keys(SUPPORTED_OPERATORS);
}

/**
 * Extract operators from selector object
 */
export function extractOperatorsFromSelector(
  selector: Record<string, any>,
): string[] {
  const operators = new Set<string>();

  function walk(obj: any) {
    if (typeof obj !== "object" || obj === null) return;

    for (const key of Object.keys(obj)) {
      if (key.startsWith("$")) {
        operators.add(key);
      }
      walk(obj[key]);
    }
  }

  walk(selector);
  return Array.from(operators);
}

/**
 * Validate selector contains only supported operators
 */
export function validateSelectorOperators(selector: Record<string, any>): {
  valid: boolean;
  unsupported: string[];
} {
  const operators = extractOperatorsFromSelector(selector);
  const unsupported = operators.filter((op) => !isSupportedOperator(op));
  return {
    valid: unsupported.length === 0,
    unsupported,
  };
}
