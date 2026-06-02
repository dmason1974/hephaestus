# Optimization Scope and Resource Priorities

## Clarifications from User

### **Optimization Scope**
**Question:** Is this just for mobilization plan? Or research too?

**Answer:** The optimizer covers **both research AND mobilization**:

1. **Research Phase:**
   - When to research each level (L1-L5)
   - Research slot allocation
   - Research timing relative to mobilization needs

2. **Mobilization Phase:**
   - Which cities to use
   - What Recruiting Office levels to build
   - How many units to mobilize at each level
   - Unit allocation across cities

**Integration:** Research schedule feeds into mobilization timing, so they must be optimized together.

---

### **Optimization Objective**

**Primary Goal:** **Minimize total cost** across all resources

**Cost Components:**
1. **Building costs** (Recruiting Office upgrades)
2. **Mobilization costs** (one-time unit creation)
3. **Upkeep costs** (ongoing maintenance until deadline)

**Total Cost Formula:**
```
Total Cost = Building Cost + Mobilization Cost + Upkeep Cost
```

Where each cost is a weighted sum across resources.

---

### **Resource Priority Weights**

**User-Specified Priorities:**
1. **Electronics** - Highest priority (most valuable/scarce)
2. **Supplies** - Second priority
3. **Rares** - Third priority
4. (Other resources - lower priority)

**Current Default Weights** (from [`cost-calculator.ts:87-94`](src/engine/optimization/cost-calculator.ts:87-94)):
```typescript
const defaultWeights: Record<Resource, number> = {
  supplies: 1.0,      // User priority: #2
  components: 1.2,
  fuel: 0.8,
  electronics: 1.5,   // User priority: #1 (should be HIGHEST)
  rares: 2.0,         // User priority: #3 (currently highest!)
  cash: 0.5,
  manpower: 1.0,
};
```

**⚠️ MISMATCH DETECTED:** Current weights don't match user priorities!

**Recommended Updated Weights:**
```typescript
const userPriorityWeights: Record<Resource, number> = {
  electronics: 3.0,   // #1 priority - HIGHEST weight
  supplies: 2.0,      // #2 priority
  rares: 1.5,         // #3 priority
  components: 1.2,    // Medium priority
  manpower: 1.0,      // Standard
  fuel: 0.8,          // Lower priority
  cash: 0.5,          // Lowest priority (most abundant)
};
```

**Rationale:**
- Electronics gets highest weight (3.0) as it's most scarce/valuable
- Supplies second (2.0) as it's commonly needed
- Rares third (1.5) as it's moderately scarce
- Other resources weighted by relative scarcity/importance

---

## Optimization Strategy

### **Single Objective: Minimize Weighted Cost**

Since the user wants to minimize cost (not time), the optimization is straightforward:

```typescript
function optimizeForceProjection(
  unitId: string,
  totalUnits: number,
  constraints: OptimizationConstraints,
  unitCatalog: UnitCatalog,
  buildings: BuildingsFile,
  scenario: ScenarioFile,
  resourceWeights: Record<Resource, number> // User-specified weights
): OptimizationResult {
  
  // Generate all configurations
  const allConfigs = generateMobilizationConfigs(...);
  
  // Filter feasible (meet deadline)
  const feasibleConfigs = filterFeasibleConfigs(...);
  
  // Score each by weighted cost
  const scoredConfigs = feasibleConfigs.map(config => {
    const batchAllocation = optimizeBatchAllocation(...);
    const cost = calculateTotalCost(...);
    
    // Use user-specified resource weights
    const weightedCost = resourceCostToScalar(
      sumResourceCosts(
        cost.buildingCost,
        cost.mobilizationCost,
        cost.upkeepCost
      ),
      resourceWeights
    );
    
    return { config, batchAllocation, cost, score: weightedCost };
  });
  
  // Return minimum cost solution
  return scoredConfigs.sort((a, b) => a.score - b.score)[0];
}
```

### **Tiebreaker Logic**

When multiple solutions have the same weighted cost:

1. **Primary:** Weighted cost (electronics > supplies > rares > others)
2. **Tiebreaker 1:** Minimize electronics usage
3. **Tiebreaker 2:** Minimize supplies usage
4. **Tiebreaker 3:** Minimize rares usage
5. **Tiebreaker 4:** Minimize completion time

```typescript
function compareByPriority(a: Solution, b: Solution): number {
  // Primary: Total weighted cost
  if (a.weightedCost !== b.weightedCost) {
    return a.weightedCost - b.weightedCost;
  }
  
  // Tiebreaker 1: Electronics
  const electronicsA = a.cost.electronics ?? 0;
  const electronicsB = b.cost.electronics ?? 0;
  if (electronicsA !== electronicsB) {
    return electronicsA - electronicsB;
  }
  
  // Tiebreaker 2: Supplies
  const suppliesA = a.cost.supplies ?? 0;
  const suppliesB = b.cost.supplies ?? 0;
  if (suppliesA !== suppliesB) {
    return suppliesA - suppliesB;
  }
  
  // Tiebreaker 3: Rares
  const raresA = a.cost.rares ?? 0;
  const raresB = b.cost.rares ?? 0;
  if (raresA !== raresB) {
    return raresA - raresB;
  }
  
  // Tiebreaker 4: Completion time
  return a.completionHour - b.completionHour;
}
```

---

## Research Optimization

### **Research Schedule Considerations**

Research affects mobilization in two ways:

1. **Timing:** Can't mobilize level N until research completes
2. **Cost:** Research has upfront resource costs

**Research Strategy Options:**

#### **Option A: Greedy (Research ASAP)**
- Research each level as soon as unlocked
- Maximizes time available for mobilization
- Higher total upkeep (units ready earlier)

#### **Option B: Just-In-Time**
- Research only when needed for mobilization
- Minimizes upkeep costs
- Riskier (less time buffer)

#### **Option C: Optimal**
- Balance research timing with mobilization needs
- Minimize total cost (research + mobilization + upkeep)
- Most complex but best results

**Recommendation:** Start with **Greedy** (simple), add **Optimal** later if needed.

---

## Batch Allocation Optimization

### **The Critical Subproblem**

Given a configuration (cities + RO levels), how should we distribute units across levels L1-L5?

**Trade-offs:**
- **Higher levels:** More expensive mobilization, higher upkeep, better capability
- **Lower levels:** Cheaper mobilization, lower upkeep, weaker capability

**Constraints:**
- Must meet deadline
- Must produce exactly N total units
- Research dependencies (can't mobilize L3 before L2 researched)

**Optimization Goal:** Minimize weighted cost while meeting deadline

### **Algorithm Options:**

#### **1. Greedy: Maximize Highest Level**
```typescript
function greedyBatchAllocation(
  totalUnits: number,
  maxLevel: number,
  deadline: number
): BatchAllocation {
  // Try to mobilize as many at maxLevel as possible
  // Fill remainder with lower levels
  // Simple but may not be optimal
}
```

#### **2. Dynamic Programming: Optimal Distribution**
```typescript
function dpBatchAllocation(
  unitId: string,
  totalUnits: number,
  config: MobilizationConfig,
  researchSchedule: ResearchSchedule,
  deadline: number,
  unitCatalog: UnitCatalog,
  buildings: BuildingsFile,
  resourceWeights: Record<Resource, number>
): BatchAllocation {
  // DP state: dp[units][level] = min cost to mobilize 'units' up to 'level'
  // Transition: Try allocating k units at level i
  // Result: Optimal distribution minimizing weighted cost
}
```

#### **3. Cost-Balanced: Minimize Cost Per Unit**
```typescript
function costBalancedAllocation(
  unitId: string,
  totalUnits: number,
  config: MobilizationConfig,
  researchSchedule: ResearchSchedule,
  deadline: number,
  unitCatalog: UnitCatalog,
  buildings: BuildingsFile,
  resourceWeights: Record<Resource, number>
): BatchAllocation {
  // Calculate cost per unit at each level (mobilization + upkeep)
  // Allocate to minimize total weighted cost
  // Respects deadline constraints
}
```

**Recommendation:** Implement all three, use **Cost-Balanced** as default (good balance of simplicity and optimality).

---

## Implementation Priorities

### **Phase 1: Core Optimization (Days 1-2)**

1. ✅ Update resource weights in [`cost-calculator.ts`](src/engine/optimization/cost-calculator.ts:86)
   ```typescript
   const defaultWeights: Record<Resource, number> = {
     electronics: 3.0,   // User priority #1
     supplies: 2.0,      // User priority #2
     rares: 1.5,         // User priority #3
     components: 1.2,
     manpower: 1.0,
     fuel: 0.8,
     cash: 0.5,
   };
   ```

2. ✅ Create `batch-allocation-optimizer.ts`
   - Implement cost-balanced allocation
   - Add greedy fallback
   - Consider research timing

3. ✅ Create `research-schedule-optimizer.ts`
   - Implement greedy research schedule
   - Integrate with scenario unlock days

### **Phase 2: Exhaustive Search (Days 2-3)**

4. ✅ Create `exhaustive-optimizer.ts`
   - Generate all configs
   - Filter by deadline feasibility
   - Optimize batch allocation for each
   - Return minimum weighted cost solution

5. ✅ Add tiebreaker logic
   - Electronics > Supplies > Rares > Time

### **Phase 3: Integration & Testing (Days 3-4)**

6. ✅ Integration with existing simulation
7. ✅ Comprehensive testing with real scenarios
8. ✅ Validate against manual strategies

### **Phase 4: CLI & Documentation (Day 5)**

9. ✅ CLI tool with resource weight configuration
10. ✅ Documentation and examples

---

## Key Decisions Summary

| Aspect | Decision |
|--------|----------|
| **Scope** | Research + Mobilization (both) |
| **Objective** | Minimize weighted cost |
| **Resource Weights** | Electronics (3.0) > Supplies (2.0) > Rares (1.5) |
| **Tiebreaker** | Electronics > Supplies > Rares > Time |
| **Algorithm** | Exhaustive search (not beam search) |
| **Batch Allocation** | Cost-balanced (with greedy fallback) |
| **Research Strategy** | Greedy (research ASAP) |

---

## Questions for User

1. **Deadline Handling:** Should we fail if no solution meets deadline, or return best effort?
2. **Resource Constraints:** Should we consider available resources, or assume unlimited?
3. **Multi-Unit:** Will you want to optimize multiple unit types together later?
4. **Output Format:** What information do you want in the optimization result?

---

## Next Steps

1. ✅ Update resource weights in cost calculator
2. ✅ Implement batch allocation optimizer (cost-balanced)
3. ✅ Implement research schedule optimizer (greedy)
4. ✅ Implement exhaustive search optimizer
5. ✅ Add comprehensive testing
6. ✅ Create CLI tool
7. ✅ Document usage

**Ready to proceed with implementation?**