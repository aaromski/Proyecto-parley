import { canSaveApprovedPick, type MarketDecision, type MarketId } from "./analysis.ts";

export const SLIP_STORAGE_KEY = "football-analysis-slip-v1";

export type SlipSelection = {
  id: string;
  matchId: number;
  season: number;
  teamId: number;
  teamName: string;
  opponentName: string;
  kickoff: string;
  competitionName: string;
  marketId: MarketId;
  marketName: string;
  selectionId: string;
  verdict: "SUBIR LÍNEA" | "APROBADO LÍNEA BASE";
  ruleVersion: string;
  savedAt: string;
};

export type SlipReadResult = { selections: SlipSelection[]; invalid: boolean };
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isSlipSelection(value: unknown): value is SlipSelection {
  if (!value || typeof value !== "object") return false;
  const selection = value as Partial<SlipSelection>;
  return typeof selection.id === "string"
    && Number.isInteger(selection.matchId) && Number.isInteger(selection.season) && Number.isInteger(selection.teamId)
    && typeof selection.teamName === "string" && typeof selection.opponentName === "string"
    && typeof selection.kickoff === "string" && typeof selection.competitionName === "string"
    && typeof selection.marketId === "string" && typeof selection.marketName === "string"
    && typeof selection.selectionId === "string" && typeof selection.ruleVersion === "string"
    && typeof selection.savedAt === "string"
    && (selection.verdict === "SUBIR LÍNEA" || selection.verdict === "APROBADO LÍNEA BASE");
}

export function readSlip(storage: StorageLike): SlipReadResult {
  try {
    const stored = storage.getItem(SLIP_STORAGE_KEY);
    if (stored === null) return { selections: [], invalid: false };
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { selections?: unknown }).selections)) {
      return { selections: [], invalid: true };
    }
    const selections = (parsed as { selections: unknown[] }).selections;
    if (!selections.every(isSlipSelection)) return { selections: [], invalid: true };
    return { selections, invalid: false };
  } catch {
    return { selections: [], invalid: true };
  }
}

function writeSlip(storage: StorageLike, selections: SlipSelection[]): void {
  storage.setItem(SLIP_STORAGE_KEY, JSON.stringify({ version: 1, selections }));
}

export function saveApprovedPick(storage: StorageLike, selection: SlipSelection, decision: Pick<MarketDecision, "evaluation" | "verdict">): SlipSelection[] {
  if (!canSaveApprovedPick(decision) || selection.verdict !== decision.verdict) {
    throw new Error("Solo se pueden guardar selecciones aprobadas por el motor.");
  }
  const current = readSlip(storage);
  if (current.invalid) throw new Error("El Slip guardado no tiene un formato válido.");
  const selections = current.selections.some((saved) => saved.id === selection.id)
    ? current.selections
    : [...current.selections, selection];
  writeSlip(storage, selections);
  return selections;
}

export function removeSlipSelection(storage: StorageLike, id: string): SlipSelection[] {
  const current = readSlip(storage);
  if (current.invalid) throw new Error("El Slip guardado no tiene un formato válido.");
  const selections = current.selections.filter((selection) => selection.id !== id);
  writeSlip(storage, selections);
  return selections;
}

export function clearSlip(storage: StorageLike): void {
  storage.removeItem(SLIP_STORAGE_KEY);
}