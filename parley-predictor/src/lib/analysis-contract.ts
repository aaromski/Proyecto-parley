export const RULE_TRIGGERS = [
  "goalkeeping",
  "penalties",
  "aerialPressure",
  "fatigueTransition",
  "other",
] as const;

export type RuleTrigger = (typeof RULE_TRIGGERS)[number];

export type Market = {
  id: string;
  name: string;
  description: string;
  line: string;
  baseCushion: number;
};

export type Rule = {
  id: string;
  name: string;
  instructions: string;
  riskFactor: number;
  trigger: RuleTrigger;
};

export type AnalysisRequest = {
  rawMatchData: string;
  markets: Market[];
  rules: Rule[];
};

export type NormalizedData = Record<string, JsonValue>;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ActiveRuleMetadata = {
  id: string;
  name: string;
  trigger: RuleTrigger;
  riskFactor: number;
};

export type Verdict = {
  marketId: string;
  selection: string;
  probability: number;
  rationale: string;
  activeRuleIds: string[];
  riskSum: number;
  baseCushion: number;
  adjustedCushion: number;
  activeRules: ActiveRuleMetadata[];
};

export type AnalysisResponse = {
  normalizedData: NormalizedData;
  verdicts: Verdict[];
};

export const ANALYSIS_LIMITS = {
  requestBytes: 256 * 1024,
  rawMatchDataCharacters: 50_000,
  markets: 30,
  rules: 30,
  verdicts: 100,
  idCharacters: 100,
  nameCharacters: 120,
  descriptionCharacters: 2_000,
  instructionsCharacters: 2_000,
  lineCharacters: 100,
  selectionCharacters: 200,
  rationaleCharacters: 500,
  modelResponseBytes: 1024 * 1024,
  normalizedJsonBytes: 100 * 1024,
} as const;

export class ContractValidationError extends Error {
  readonly code = "INVALID_REQUEST";

  constructor(message: string) {
    super(message);
    this.name = "ContractValidationError";
  }
}

export class ModelResponseValidationError extends Error {
  constructor() {
    super("The analysis provider returned an invalid response.");
    this.name = "ModelResponseValidationError";
  }
}

  const EXCLUDED_METRIC_ALIASES = [
    "saque de banda",
    "saques de banda",
    "saque lateral",
    "saques laterales",
    "throw in",
    "throw ins",
    "throw-in",
    "throw-ins",
    "goal kick",
    "goal kicks",
    "saque de meta",
    "saques de meta",
    "saque de porteria",
    "saques de porteria",
    "fuera de juego",
    "fueras de juego",
    "offside",
    "offsides",
    "pase en campo propio",
    "pases en campo propio",
    "passes in own half",
    "pass in own half",
    "own half passes",
    "gol por pie",
    "goles por pie",
    "gol con el pie",
    "goles con el pie",
    "goals by foot",
    "goal by foot",
    "foot goals",
    "disparo al palo",
    "disparos al palo",
    "tiro al palo",
    "tiros al palo",
    "disparo al poste",
    "disparos al poste",
    "shot hitting the post",
    "shots hitting the post",
    "shots hit the post",
    "shots on the post",
    "woodwork",
  ] as const;

  const METRIC_LABEL_KEYS = new Set([
    "metric",
    "metric name",
    "name",
    "label",
    "category",
    "stat",
    "stat name",
  ]);

  function normalizeMetricLabel(value: string): string {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function isExcludedMetric(value: string): boolean {
    const normalized = normalizeMetricLabel(value);
    return EXCLUDED_METRIC_ALIASES.some((alias) =>
      normalized.includes(normalizeMetricLabel(alias)),
    );
  }

  function isExcludedMetricEntry(value: JsonValue): boolean {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      return false;
    }
    return Object.entries(value).some(
      ([key, label]) =>
        METRIC_LABEL_KEYS.has(normalizeMetricLabel(key)) &&
        typeof label === "string" &&
        isExcludedMetric(label),
    );
  }

  function removeExcludedMetrics(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
      return value
        .filter((item) => !isExcludedMetricEntry(item))
        .map((item) => removeExcludedMetrics(item));
    }
    if (value !== null && typeof value === "object") {
      if (isExcludedMetricEntry(value)) return {};
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key, item]) => !isExcludedMetric(key) && !isExcludedMetricEntry(item))
          .map(([key, item]) => [key, removeExcludedMetrics(item)]),
      );
    }
    return value;
  }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new ContractValidationError("The request contains unsupported fields.");
  }
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    (!allowEmpty && value.trim().length === 0)
  ) {
    throw new ContractValidationError(`Invalid ${field}.`);
  }
  return value;
}

function requiredNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum = Number.MAX_VALUE,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ContractValidationError(`Invalid ${field}.`);
  }
  return value;
}

function parseMarkets(value: unknown): Market[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > ANALYSIS_LIMITS.markets
  ) {
    throw new ContractValidationError("Select between 1 and 30 markets.");
  }

  const markets = value.map((item): Market => {
    if (!isRecord(item)) {
      throw new ContractValidationError("Invalid market configuration.");
    }
    assertExactKeys(item, ["id", "name", "description", "line", "baseCushion"]);
    return {
      id: requiredString(item.id, "market id", ANALYSIS_LIMITS.idCharacters),
      name: requiredString(item.name, "market name", ANALYSIS_LIMITS.nameCharacters),
      description: requiredString(
        item.description,
        "market description",
        ANALYSIS_LIMITS.descriptionCharacters,
        true,
      ),
      line: requiredString(item.line, "market line", ANALYSIS_LIMITS.lineCharacters),
      baseCushion: requiredNumber(item.baseCushion, "baseCushion", 0),
    };
  });

  if (new Set(markets.map(({ id }) => id)).size !== markets.length) {
    throw new ContractValidationError("Market ids must be unique.");
  }
  return markets;
}

function parseRules(value: unknown): Rule[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > ANALYSIS_LIMITS.rules
  ) {
    throw new ContractValidationError("Select between 1 and 30 rules.");
  }

  const rules = value.map((item): Rule => {
    if (!isRecord(item)) {
      throw new ContractValidationError("Invalid rule configuration.");
    }
    assertExactKeys(item, ["id", "name", "instructions", "riskFactor", "trigger"]);
    if (
      typeof item.trigger !== "string" ||
      !RULE_TRIGGERS.includes(item.trigger as RuleTrigger)
    ) {
      throw new ContractValidationError("Invalid rule trigger.");
    }
    return {
      id: requiredString(item.id, "rule id", ANALYSIS_LIMITS.idCharacters),
      name: requiredString(item.name, "rule name", ANALYSIS_LIMITS.nameCharacters),
      instructions: requiredString(
        item.instructions,
        "rule instructions",
        ANALYSIS_LIMITS.instructionsCharacters,
        true,
      ),
      riskFactor: requiredNumber(item.riskFactor, "riskFactor", 0, 1),
      trigger: item.trigger as RuleTrigger,
    };
  });

  if (new Set(rules.map(({ id }) => id)).size !== rules.length) {
    throw new ContractValidationError("Rule ids must be unique.");
  }
  return rules;
}

export function parseAnalysisRequest(value: unknown): AnalysisRequest {
  if (!isRecord(value)) {
    throw new ContractValidationError("The request body must be a JSON object.");
  }
  assertExactKeys(value, ["rawMatchData", "markets", "rules"]);

  return {
    rawMatchData: requiredString(
      value.rawMatchData,
      "rawMatchData",
      ANALYSIS_LIMITS.rawMatchDataCharacters,
    ),
    markets: parseMarkets(value.markets),
    rules: parseRules(value.rules),
  };
}

function validateJsonValue(value: unknown, depth: number, count: { value: number }): boolean {
  count.value += 1;
  if (count.value > 5_000 || depth > 12) return false;
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value === "string") return value.length <= 10_000;
  if (Array.isArray(value)) {
    return value.every((item) => validateJsonValue(item, depth + 1, count));
  }
  if (isRecord(value)) {
    return Object.entries(value).every(
      ([key, item]) => key.length <= 200 && validateJsonValue(item, depth + 1, count),
    );
  }
  return false;
}

export function parseNormalizedData(value: unknown): NormalizedData {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new ModelResponseValidationError();
    }
  }
  if (!isRecord(value)) {
    throw new ModelResponseValidationError();
  }

  let normalizedData = Object.prototype.hasOwnProperty.call(value, "normalizedData")
    ? value.normalizedData
    : value;
  if (typeof normalizedData === "string") {
    try {
      normalizedData = JSON.parse(normalizedData);
    } catch {
      throw new ModelResponseValidationError();
    }
  }
  if (!isRecord(normalizedData) || !validateJsonValue(normalizedData, 0, { value: 0 })) {
    throw new ModelResponseValidationError();
  }
  if (
    new TextEncoder().encode(JSON.stringify(normalizedData)).byteLength >
    ANALYSIS_LIMITS.normalizedJsonBytes
  ) {
    throw new ModelResponseValidationError();
  }
  return removeExcludedMetrics(normalizedData as NormalizedData) as NormalizedData;
}

export function parseModelVerdicts(
  value: unknown,
  request: AnalysisRequest,
): Array<Omit<Verdict, "riskSum" | "baseCushion" | "adjustedCushion" | "activeRules">> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray(value.verdicts) ||
    value.verdicts.length > ANALYSIS_LIMITS.verdicts
  ) {
    throw new ModelResponseValidationError();
  }

  const marketIds = new Set(request.markets.map(({ id }) => id));
  const rulesById = new Map<string, Rule>(
    request.rules.map((rule) => [rule.id, rule] as const),
  );
  return value.verdicts.map((item) => {
    if (!isRecord(item)) throw new ModelResponseValidationError();
    const expectedKeys = [
      "marketId",
      "selection",
      "probability",
      "rationale",
      "activeRuleIds",
    ];
    if (
      Object.keys(item).length !== expectedKeys.length ||
      Object.keys(item).some((key) => !expectedKeys.includes(key)) ||
      typeof item.marketId !== "string" ||
      !marketIds.has(item.marketId) ||
      typeof item.probability !== "number" ||
      !Number.isFinite(item.probability) ||
      item.probability < 0 ||
      item.probability > 1 ||
      !Array.isArray(item.activeRuleIds) ||
      item.activeRuleIds.length > request.rules.length
    ) {
      throw new ModelResponseValidationError();
    }

    const selection = item.selection;
    const rationale = item.rationale;
    if (
      typeof selection !== "string" ||
      selection.trim().length === 0 ||
      selection.length > ANALYSIS_LIMITS.selectionCharacters ||
      typeof rationale !== "string" ||
      rationale.trim().length === 0 ||
      rationale.length > ANALYSIS_LIMITS.rationaleCharacters
    ) {
      throw new ModelResponseValidationError();
    }

    const activeRuleIds = item.activeRuleIds.map((id) => {
      if (typeof id !== "string" || !rulesById.has(id)) {
        throw new ModelResponseValidationError();
      }
      return id;
    });
    if (new Set(activeRuleIds).size !== activeRuleIds.length) {
      throw new ModelResponseValidationError();
    }

    return {
      marketId: item.marketId,
      selection,
      probability: item.probability,
      rationale,
      activeRuleIds,
    };
  });
}