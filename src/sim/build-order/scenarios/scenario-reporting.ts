import { scenarioStartAbsoluteHour, toAbsoluteHour, type ScenarioStartLike } from "../../../core/time.js";

export function mapDayStartAbsoluteHour(mapDay: number): number {
  return toAbsoluteHour(mapDay, 0);
}

export function mapDayEndAbsoluteHour(mapDay: number): number {
  return toAbsoluteHour(mapDay + 1, 0);
}

export function mapDayForAbsoluteHour(absoluteHour: number): number {
  return Math.floor(absoluteHour / 24) + 1;
}

export function hourOfMapDay(absoluteHour: number): number {
  return absoluteHour % 24;
}

export function scenarioReportWindow(scenario: ScenarioStartLike, mapDaysToReport: number) {
  const startAbs = scenarioStartAbsoluteHour(scenario);
  const startMapDay = scenario.start.day;
  const endMapDay = startMapDay + mapDaysToReport - 1;
  const endAbsExclusive = mapDayEndAbsoluteHour(endMapDay);
  const hoursToSimulate = endAbsExclusive - startAbs;
  const relativeDaysToSimulate = Math.ceil(hoursToSimulate / 24);

  return {
    startAbs,
    startMapDay,
    endMapDay,
    endAbsExclusive,
    hoursToSimulate,
    relativeDaysToSimulate,
  };
}

export type HourlyAmountRow = {
  hour: number;
  amount: number;
};

export type MapDayAggregateRow = {
  mapDay: number;
  mapDayStartAbs: number;
  hoursCounted: number;
  total: number;
};

export function aggregateHourlyAmountsByMapDay(args: {
  rows: HourlyAmountRow[];
  scenario: ScenarioStartLike;
  mapDaysToReport: number;
}): MapDayAggregateRow[] {
  const window = scenarioReportWindow(args.scenario, args.mapDaysToReport);
  const totals = new Map<number, MapDayAggregateRow>();

  for (let mapDay = window.startMapDay; mapDay <= window.endMapDay; mapDay++) {
    totals.set(mapDay, {
      mapDay,
      mapDayStartAbs: mapDayStartAbsoluteHour(mapDay),
      hoursCounted: 0,
      total: 0,
    });
  }

  for (const row of args.rows) {
    const absoluteHour = window.startAbs + row.hour - 1;
    if (absoluteHour < window.startAbs || absoluteHour >= window.endAbsExclusive) continue;

    const mapDay = mapDayForAbsoluteHour(absoluteHour);
    const bucket = totals.get(mapDay);
    if (!bucket) continue;

    bucket.hoursCounted += 1;
    bucket.total += row.amount;
  }

  return Array.from(totals.values());
}
