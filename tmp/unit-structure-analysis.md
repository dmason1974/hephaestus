# Unit Structure Analysis

## Key Findings from Unit YAML Files

### 1. **Unit Levels**
- Units have **variable number of levels** (not always 5)
- Example: `air_superiority_fighter` has 4 levels (1-4)
- Example: `stealth_air_superiority_fighter` has only 1 level
- Example: `mercenary` has 4 levels (1-4)

### 2. **Building Requirements**

Each level has a `requirements` array that specifies:

**Required Buildings:**
- `air_base level X` - Required for air units
- `arms_industry level X` - Required for most units
- `mercenary_outpost level X` - Required for mercenaries
- `secret_weapons_lab level X` - Required for stealth units

**Previous Level Requirements:**
- `air_superiority_fighter level 3` - Must research previous level first
- Forms a dependency chain: L1 → L2 → L3 → L4

### 3. **Research Timing**
- `unlock_day`: When research becomes available (e.g., day 1, 3, 6, 11, 16)
- `time`: How long research takes (hours/days)
- `cost`: Resources needed for research

### 4. **Mobilization**
- `time`: How long to mobilize one unit
- `cost`: Resources per unit
- No `unit_limit` in these examples (unlimited mobilization)

### 5. **Daily Upkeep**
- Ongoing cost per unit per day
- Primarily fuel, electronics, cash, manpower

## Optimization Implications

### **Building Requirements Must Be Met**
The optimizer must ensure:
1. **Required buildings exist** at specified levels
2. **Building upgrades are scheduled** before unit mobilization
3. **Building costs are included** in total cost calculation

Example for `air_superiority_fighter` level 1:
- Requires: `air_base level 1` + `arms_industry level 1`
- Must build/upgrade these BEFORE mobilizing

### **Research Dependencies**
- Must research levels in order: L1 → L2 → L3 → L4
- Cannot skip levels
- Research timing depends on `unlock_day` and scenario start

### **Variable Level Support**
The `BatchAllocation` type needs to be dynamic:
```typescript
// Current (WRONG - hardcoded to 5 levels):
type BatchAllocation = {
  L1: number;
  L2: number;
  L3: number;
  L4: number;
  L5: number;
};

// Should be (CORRECT - dynamic):
type BatchAllocation = Record<number, number>;
// or
type BatchAllocation = Map<number, number>;
```

### **Recruiting Office Trade-off**
From user feedback:
> "optional buildings of recruiting office levels are mainly mobilisation accelerators and there is trade off between their cost and upkeep reduction"
> "it is also a question of does it make more sense to go higher ro or start mobilising in another city. going to RO5 is the equivalent of another mobilisation city in terms of capacity gain"

**Key Trade-off: RO Level vs. Additional Cities**

- **Option A: Higher RO in fewer cities**
  - Example: 1 city with RO5
  - Pros: Concentrated investment, faster per-city mobilization
  - Cons: Higher building cost per city, single point of failure

- **Option B: Lower RO in more cities**
  - Example: 2 cities with RO2-3
  - Pros: Distributed capacity, lower per-city building cost
  - Cons: More cities to manage, potentially higher total building cost

**Capacity Equivalence:**
- **RO5 ≈ 2x mobilization capacity** of RO1 (approximately)
- Going from RO1 → RO5 in 1 city ≈ Adding another city with RO1
- But costs are different!

**Optimization Question:**
For N units to mobilize, which is cheaper:
1. **Fewer cities + Higher RO levels** (concentrated)
2. **More cities + Lower RO levels** (distributed)

This is exactly what the exhaustive search will explore!

## Recommended Approach

### **Phase 1: Type System Updates**
1. Change `BatchAllocation` to `Record<number, number>`
2. Update all functions to work with dynamic levels
3. Add helper to get max level from unit catalog

### **Phase 2: Building Requirement Tracking**
1. Parse `requirements` array from unit levels
2. Extract required buildings and their levels
3. Include building costs in optimization
4. Ensure buildings are scheduled before mobilization

### **Phase 3: Research Strategy**
1. **Default**: Research to maximum available level before deadline
2. **Greedy**: Research each level as soon as unlocked
3. **Respect dependencies**: L1 → L2 → L3 → ...
4. **Consider unlock_day**: Can't research before scenario day + unlock_day

### **Phase 4: Mobilization Strategy**
After research complete:
1. **Option A**: Mobilize all at max level (simplest)
2. **Option B**: Distribute across levels for cost optimization
3. **Constraint**: Must meet deadline
4. **Trade-off**: Higher levels = more expensive but better capability

## Next Steps

1. ✅ Update `BatchAllocation` type to support variable levels
2. ✅ Add building requirement extraction
3. ✅ Implement research scheduler (greedy to max level)
4. ✅ Implement batch allocator (cost-optimized distribution)
5. ✅ Integrate with existing cost calculator

## IMPORTANT: No Global Level Cap

**From user clarification:**
> "research levels for units are not capped other than by presence of a research level in the yaml's. there is no global rule here"

**What this means:**
- **NO assumption** that units have 5 levels max
- **NO assumption** that all units have the same number of levels
- **Each unit defines its own levels** in the YAML
- **Max level = highest level present** in that unit's YAML

**Implementation Impact:**
```typescript
// WRONG - assumes all units have 5 levels:
const maxLevel = 5;

// CORRECT - query the unit catalog:
function getMaxLevel(unitId: string, unitCatalog: UnitCatalog): number {
  const unit = unitCatalog.units[unitId];
  return Math.max(...Object.keys(unit.levels).map(Number));
}
```

**Examples from data:**
- `air_superiority_fighter`: 4 levels (1, 2, 3, 4)
- `stealth_air_superiority_fighter`: 1 level (1 only)
- `mercenary`: 4 levels (1, 2, 3, 4)
- Some units might have 6, 7, or more levels in other scenarios

**Optimizer must:**
1. Query unit catalog for actual max level
2. Research to that max level (if time permits)
3. Support any number of levels dynamically