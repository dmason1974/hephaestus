export type ScenarioStartLike = {
  start: {
    day: number;
    hour: number;
  };
};

export function toAbsoluteHour(day: number, hour: number): number {
  return ((day - 1) * 24) + hour;
}

export function scenarioStartAbsoluteHour(scenario: ScenarioStartLike): number {
  return toAbsoluteHour(scenario.start.day, scenario.start.hour);
}

export function dayStartAbsoluteHour(
  scenario: ScenarioStartLike,
  dayIndex: number
): number {
  return scenarioStartAbsoluteHour(scenario) + ((dayIndex - 1) * 24);
}
