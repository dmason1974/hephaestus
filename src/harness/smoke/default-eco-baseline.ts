import type { Country } from "../../schemas/country-schema.js";
import type { BuildAction } from "../../engine/simulation/build-order-sim.js";
import type { ProvinceBuildAction } from "../../engine/simulation/province-build-order-sim.js";
import { buildProvinceCohortsFromCountry } from "../../engine/provinces/province-cohorts.js";

type CityResource =
  | "supplies"
  | "components"
  | "fuel"
  | "rares"
  | "electronics";

export type HomelandEcoBaselineConfig = {
  name: string;
  cityArmsIndustryTargets: Record<CityResource, number>;
  recruitingOfficeFirstLevel: number;
  electronicsCityOpening: {
    initialArmsIndustryLevel: number;
    relocateHeadquartersAfterInitialArmsIndustry: boolean;
    finalArmsIndustryLevel: number;
  };
  electronicsProvinceBuild: {
    combatOutpostLevel: number;
    localIndustryLevel: number;
  };
};

export const challengeHomelandEcoBaseline: HomelandEcoBaselineConfig = {
  name: "challenge_homeland_default",
  cityArmsIndustryTargets: {
    supplies: 5,
    components: 2,
    fuel: 1,
    rares: 5,
    electronics: 5,
  },
  recruitingOfficeFirstLevel: 1,
  electronicsCityOpening: {
    initialArmsIndustryLevel: 1,
    relocateHeadquartersAfterInitialArmsIndustry: true,
    finalArmsIndustryLevel: 5,
  },
  electronicsProvinceBuild: {
    combatOutpostLevel: 1,
    localIndustryLevel: 3,
  },
};

export function buildHomelandCityBuildOrderFromBaseline(
  country: Country,
  baseline: HomelandEcoBaselineConfig = challengeHomelandEcoBaseline
): BuildAction[] {
  const actions: BuildAction[] = [];

  for (const city of country.cities) {
    const cityId = `${country.country.id}:${city.id}`;

    if (baseline.recruitingOfficeFirstLevel > 0) {
      actions.push({
        cityId,
        buildingId: "recruiting_office",
        targetLevel: baseline.recruitingOfficeFirstLevel,
      });
    }

    if (city.resource === "electronics") {
      const opening = baseline.electronicsCityOpening;

      if (opening.initialArmsIndustryLevel > 0) {
        actions.push({
          cityId,
          buildingId: "arms_industry",
          targetLevel: opening.initialArmsIndustryLevel,
        });
      }

      if (opening.relocateHeadquartersAfterInitialArmsIndustry) {
        actions.push({
          cityId,
          buildingId: "relocate_headquarters",
          targetLevel: 1,
        });
      }

      if (opening.finalArmsIndustryLevel > opening.initialArmsIndustryLevel) {
        actions.push({
          cityId,
          buildingId: "arms_industry",
          targetLevel: opening.finalArmsIndustryLevel,
        });
      }

      continue;
    }

    const targetLevel = baseline.cityArmsIndustryTargets[city.resource as CityResource];
    if (targetLevel > 0) {
      actions.push({
        cityId,
        buildingId: "arms_industry",
        targetLevel,
      });
    }
  }

  return actions;
}

export function buildHomelandProvinceBuildOrderFromBaseline(
  country: Country,
  baseline: HomelandEcoBaselineConfig = challengeHomelandEcoBaseline
): ProvinceBuildAction[] {
  return buildProvinceCohortsFromCountry(country)
    .filter(cohort => cohort.resource === "electronics")
    .flatMap(cohort => {
      const actions: ProvinceBuildAction[] = [];

      if (baseline.electronicsProvinceBuild.combatOutpostLevel > 0) {
        actions.push({
          provinceId: cohort.provinceId,
          buildingId: "combat_outpost",
          targetLevel: baseline.electronicsProvinceBuild.combatOutpostLevel,
        });
      }

      if (baseline.electronicsProvinceBuild.localIndustryLevel > 0) {
        actions.push({
          provinceId: cohort.provinceId,
          buildingId: "local_industry",
          targetLevel: baseline.electronicsProvinceBuild.localIndustryLevel,
        });
      }

      return actions;
    });
}
