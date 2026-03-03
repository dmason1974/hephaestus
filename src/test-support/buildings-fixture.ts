import type { BuildingsFile } from "../schemas/building-schema.js";

export function buildTestBuildings(): BuildingsFile {
  return {
    schema_version: 1,
    domain: "buildings",
    resources: ["supplies", "components", "fuel", "rares", "electronics", "cash", "manpower"],
    buildings: {
      arms_industry: {
        name: "Arms Industry",
        category: "Buildings",
        levels: {
          "1": {
            build_time: { hours: 9, minutes: 45 },
            cost: {
              supplies: 0,
              components: 0,
              fuel: 0,
              rares: 0,
              electronics: 0,
              cash: 0,
              manpower: 0,
            },
            production_bonus_pct: 0.06,
            flat_bonus: {
              cash: 104,
              supplies: 5,
            },
          },
          "2": {
            build_time: { days: 1, hours: 2 },
            cost: {
              supplies: 0,
              components: 0,
              fuel: 0,
              rares: 0,
              electronics: 0,
              cash: 0,
              manpower: 0,
            },
            production_bonus_pct: 0.12,
            flat_bonus: {
              cash: 208,
              supplies: 10,
            },
          },
          "3": {
            build_time: { days: 1, hours: 12 },
            cost: {
              supplies: 0,
              components: 0,
              fuel: 0,
              rares: 0,
              electronics: 0,
              cash: 0,
              manpower: 0,
            },
            production_bonus_pct: 0.18,
            flat_bonus: {
              cash: 312,
              supplies: 15,
            },
          },
          "4": {
            build_time: { days: 2 },
            cost: {
              supplies: 0,
              components: 0,
              fuel: 0,
              rares: 0,
              electronics: 0,
              cash: 0,
              manpower: 0,
            },
            production_bonus_pct: 0.24,
            flat_bonus: {
              cash: 416,
              supplies: 20,
            },
          },
          "5": {
            build_time: { days: 3 },
            cost: {
              supplies: 0,
              components: 0,
              fuel: 0,
              rares: 0,
              electronics: 0,
              cash: 0,
              manpower: 0,
            },
            production_bonus_pct: 0.3,
            flat_bonus: {
              cash: 520,
              supplies: 25,
            },
          },
        },
      },
      underground_bunkers: {
        name: "Underground Bunkers",
        category: "Buildings",
        levels: {
          "1": {
            build_time: { days: 1 },
            cost: {
              supplies: 0,
              components: 0,
              fuel: 0,
              rares: 0,
              electronics: 0,
              cash: 0,
              manpower: 0,
            },
            morale_bonus_pct: 0.05,
          },
          "2": {
            build_time: { days: 2 },
            cost: {
              supplies: 0,
              components: 0,
              fuel: 0,
              rares: 0,
              electronics: 0,
              cash: 0,
              manpower: 0,
            },
            morale_bonus_pct: 0.1,
          },
          "3": {
            build_time: { days: 3 },
            cost: {
              supplies: 0,
              components: 0,
              fuel: 0,
              rares: 0,
              electronics: 0,
              cash: 0,
              manpower: 0,
            },
            morale_bonus_pct: 0.2,
          },
          "4": {
            build_time: { days: 4 },
            cost: {
              supplies: 0,
              components: 0,
              fuel: 0,
              rares: 0,
              electronics: 0,
              cash: 0,
              manpower: 0,
            },
            morale_bonus_pct: 0.3,
          },
          "5": {
            build_time: { days: 5 },
            cost: {
              supplies: 0,
              components: 0,
              fuel: 0,
              rares: 0,
              electronics: 0,
              cash: 0,
              manpower: 0,
            },
            morale_bonus_pct: 0.5,
          },
        },
      },
    },
  };
}
