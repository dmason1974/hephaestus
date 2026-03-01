import { baselineHomelandMoraleOnDay } from "./morale-baseline.js";

for (let d = 1; d <= 30; d++) {
  console.log(d, baselineHomelandMoraleOnDay(d).toFixed(4));
}