import type { Market, Rule } from "@/lib/analysis-contract";

export const DEFAULT_MARKETS: Market[] = [
  {
    id: "corners-over-6-5",
    name: "Córners Over 6.5",
    description: "Total de córners en el partido.",
    line: "6.5",
    baseCushion: 0,
  },
  {
    id: "total-goals-over-1-5",
    name: "Goles totales Over 1.5",
    description: "Total de goles en el partido.",
    line: "1.5",
    baseCushion: 0,
  },
  {
    id: "individual-goal-over-0-5",
    name: "Gol individual Over 0.5",
    description: "Total de goles de un equipo seleccionado.",
    line: "0.5",
    baseCushion: 0,
  },
  {
    id: "handicap-minus-1-0-minus-1-5",
    name: "Hándicap -1.0/-1.5",
    description: "Línea de hándicap seleccionada para el partido.",
    line: "-1.0/-1.5",
    baseCushion: 0,
  },
  {
    id: "match-winner-1x2",
    name: "Victoria 1X2",
    description: "Selección de resultado local, empate o visitante.",
    line: "1X2",
    baseCushion: 0,
  },
  {
    id: "double-chance-1x-x2",
    name: "Doble oportunidad 1X/X2",
    description: "Selección de doble oportunidad local o visitante.",
    line: "1X/X2",
    baseCushion: 0,
  },
];

export const DEFAULT_RULES: Rule[] = [
  {
    id: "goalkeeping",
    name: "Portería",
    instructions:
      "Considera únicamente la información disponible sobre portería; no infieras datos ausentes.",
    riskFactor: 0,
    trigger: "goalkeeping",
  },
  {
    id: "penalties",
    name: "Penales",
    instructions:
      "Considera únicamente la información disponible relacionada con penales; no infieras datos ausentes.",
    riskFactor: 0,
    trigger: "penalties",
  },
  {
    id: "aerial-pressure",
    name: "Asedio aéreo",
    instructions:
      "Considera únicamente la información disponible sobre presión aérea; no infieras datos ausentes.",
    riskFactor: 0,
    trigger: "aerialPressure",
  },
  {
    id: "fatigue-transition",
    name: "Fatiga-transición",
    instructions:
      "Considera únicamente la información disponible sobre fatiga y transiciones; no infieras datos ausentes.",
    riskFactor: 0,
    trigger: "fatigueTransition",
  },
];