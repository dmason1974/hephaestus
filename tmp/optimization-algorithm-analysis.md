# Optimization Algorithm Analysis: Is Beam Search the Right Approach?

## Problem Characteristics

Let me first analyze the force projection optimization problem structure:

### **Problem Space:**
- **Decision Variables:**
  - Number of cities to use (1 to N)
  - Recruiting Office level per city (1 to 5)
  - Unit allocation per city
  - Batch allocation across levels (L1-L5)
  - Research schedule timing

- **Constraints:**
  - Deadline (must complete by hour X)
  - Available cities
  - Maximum RO level
  - Research unlock dependencies
  - Mobilization capacity per city

- **Objectives:**
  - Minimize total cost (building + mobilization + upkeep)
  - Minimize completion time
  - Maximize efficiency (cost/time ratio)

### **Problem Size:**
For a typical scenario:
- Cities: 1-10 options
- RO levels: 1-5 per city
- Batch allocations: Continuous distribution across 5 levels
- **Configuration space:** ~50-500 discrete configs × continuous batch optimization

### **Problem Type:**
- **Mixed Integer Nonlinear Programming (MINLP)**
- Discrete choices (cities, RO levels) + continuous optimization (batch allocation)
- Multiple objectives with trade-offs
- Hard constraints (deadline feasibility)

---

## Algorithm Comparison

### **1. Beam Search** (Current Approach)

**How it works:**
- Enumerate configurations (city count × RO level combinations)
- Keep top K candidates at each step (beam width)
- Prune infeasible/suboptimal solutions
- Optimize batch allocation for each config

**Pros:**
✅ Simple to implement and understand
✅ Guaranteed to explore diverse solutions
✅ Works well with existing codebase patterns
✅ Controllable memory usage (beam width)
✅ Good for multi-objective optimization
✅ Handles discrete + continuous variables

**Cons:**
❌ May miss optimal solution if pruned early
❌ Explores many infeasible configurations
❌ No theoretical optimality guarantee
❌ Beam width tuning required

**Suitability:** ⭐⭐⭐⭐ (4/5)
- Good fit for this problem size
- Already used successfully in existing codebase
- Practical and proven approach

---

### **2. Dynamic Programming**

**How it works:**
- Build solution incrementally
- Cache subproblem solutions
- Guarantee optimal solution

**Pros:**
✅ Optimal solution guaranteed
✅ Efficient for problems with overlapping subproblems
✅ No parameter tuning needed

**Cons:**
❌ Requires clear subproblem structure
❌ State space explosion for multi-dimensional problems
❌ Difficult to handle continuous variables (batch allocation)
❌ Complex to implement for this problem

**Suitability:** ⭐⭐ (2/5)
- Problem doesn't have clear subproblem structure
- Batch allocation is continuous, not discrete
- State space too large

---

### **3. Integer Linear Programming (ILP)**

**How it works:**
- Formulate as mathematical optimization problem
- Use solver (e.g., GLPK, CBC, Gurobi)
- Get optimal solution

**Pros:**
✅ Optimal solution guaranteed
✅ Handles constraints naturally
✅ Mature solvers available
✅ Can handle large problems

**Cons:**
❌ Requires external solver dependency
❌ Complex problem formulation
❌ Nonlinear costs (morale, upkeep) need linearization
❌ Multi-objective requires scalarization
❌ Harder to debug and understand

**Suitability:** ⭐⭐⭐ (3/5)
- Would work but adds complexity
- Overkill for this problem size
- External dependency concerns

---

### **4. Genetic Algorithm**

**How it works:**
- Population of candidate solutions
- Crossover and mutation operators
- Evolve toward better solutions

**Pros:**
✅ Handles complex search spaces
✅ Good for multi-objective optimization
✅ Can escape local optima
✅ Flexible encoding

**Cons:**
❌ No optimality guarantee
❌ Many parameters to tune (population, mutation rate, etc.)
❌ Slower convergence
❌ Overkill for this problem size
❌ Harder to debug

**Suitability:** ⭐⭐ (2/5)
- Unnecessary complexity
- Problem space is small enough for simpler methods
- Slower than beam search

---

### **5. Greedy + Local Search**

**How it works:**
- Start with greedy solution (e.g., minimum cities, minimum RO)
- Iteratively improve with local moves
- Hill climbing or simulated annealing

**Pros:**
✅ Very fast
✅ Simple to implement
✅ Good for quick approximations
✅ Low memory usage

**Cons:**
❌ Gets stuck in local optima
❌ No guarantee of good solution quality
❌ Sensitive to starting point
❌ May miss better solutions

**Suitability:** ⭐⭐⭐ (3/5)
- Fast but risky
- Could be used as initialization for beam search
- Not robust enough as primary method

---

### **6. Branch and Bound**

**How it works:**
- Systematically explore search tree
- Prune branches that can't improve best solution
- Guarantee optimal solution

**Pros:**
✅ Optimal solution guaranteed
✅ Efficient pruning
✅ Works well for discrete optimization

**Cons:**
❌ Exponential worst-case complexity
❌ Requires good bounding function
❌ Complex to implement correctly
❌ Overkill for this problem size

**Suitability:** ⭐⭐⭐ (3/5)
- Would work but more complex than needed
- Beam search is simpler and sufficient

---

### **7. Exhaustive Search with Smart Pruning**

**How it works:**
- Generate all configurations
- Filter infeasible early
- Sort by cost
- Optimize batch allocation for top N

**Pros:**
✅ Optimal solution guaranteed (if we check all)
✅ Very simple to implement
✅ Easy to understand and debug
✅ No parameters to tune

**Cons:**
❌ Slow for large configuration spaces
❌ Wastes time on bad configurations
❌ Memory intensive

**Suitability:** ⭐⭐⭐⭐ (4/5)
- **Actually might be BETTER than beam search for this problem!**
- Configuration space is small (50-500 configs)
- Can afford to check all feasible configs
- Simpler than beam search

---

## Recommendation

### **Best Approach: Hybrid Exhaustive + Greedy**

I actually think **beam search might be overkill** for this problem. Here's why:

#### **Problem Size Analysis:**
```
Max configs = maxCities × maxROLevels
            = 10 cities × 5 RO levels
            = 50 configurations per city count
            × 10 city counts
            = 500 total configurations

After feasibility filtering: ~100-200 configs typically
```

#### **Proposed Algorithm:**

```typescript
function optimizeForceProjection(
  unitId: string,
  totalUnits: number,
  constraints: OptimizationConstraints,
  objective: OptimizationObjective,
  unitCatalog: UnitCatalog,
  buildings: BuildingsFile
): OptimizationResult {
  
  // Step 1: Generate ALL configurations (fast, ~500 configs)
  const allConfigs = generateMobilizationConfigs(
    constraints.availableCities,
    constraints.maxCities,
    constraints.maxROLevel,
    totalUnits,
    { buildings, buildingId: "recruiting_office" }
  );
  
  // Step 2: Filter feasible (removes ~60-80%)
  const feasibleConfigs = filterFeasibleConfigs(allConfigs, {
    unitId,
    batchAllocation: greedyBatchAllocation(totalUnits), // Quick estimate
    researchSchedule: optimizeResearchSchedule(unitId, scenario),
    deadlineHour: constraints.deadlineHour,
    unitCatalog,
    buildings
  });
  
  // Step 3: Score ALL feasible configs (typically 50-100 left)
  const scoredConfigs = feasibleConfigs.map(config => {
    const batchAllocation = optimizeBatchAllocation(
      unitId, totalUnits, config, researchSchedule, 
      constraints.deadlineHour, unitCatalog, buildings
    );
    
    const cost = calculateTotalCost(
      unitId, config, batchAllocation, researchSchedule,
      constraints.deadlineHour, unitCatalog, buildings
    );
    
    return {
      config,
      batchAllocation,
      cost,
      score: scoreByObjective(cost, objective)
    };
  });
  
  // Step 4: Return best
  return scoredConfigs.sort((a, b) => a.score - b.score)[0];
}
```

#### **Why This is Better:**

1. **Simpler** - No beam width parameter to tune
2. **Faster** - Configuration space is small enough to check all
3. **Optimal** - Guaranteed to find best solution in feasible set
4. **Debuggable** - Can inspect all candidates
5. **Predictable** - No randomness or pruning decisions

#### **Performance Estimate:**
```
500 configs × 0.1ms per config = 50ms total
100 feasible × 1ms batch optimization = 100ms
Total: ~150ms for complete optimization
```

This is **fast enough** that we don't need beam search complexity!

---

## When Would Beam Search Be Better?

Beam search would be superior if:
- ❌ Configuration space was 10,000+ (not the case)
- ❌ Each config evaluation was expensive (it's not, ~1ms)
- ❌ We needed incremental results (we don't)
- ❌ Memory was severely constrained (it's not)

---

## Revised Recommendation

### **Sprint 2 Should Implement:**

1. **Exhaustive Search with Smart Filtering** (Primary)
   - Generate all configs
   - Filter infeasible early
   - Optimize batch allocation for feasible configs
   - Return optimal solution

2. **Greedy Heuristics** (For comparison/validation)
   - Minimum cities + minimum RO
   - Maximum cities + maximum RO
   - Balanced approach

3. **Batch Allocation Optimizer** (Critical component)
   - Given a config, find optimal L1-L5 distribution
   - This is the real optimization challenge
   - Could use dynamic programming or greedy approach

### **Algorithm Complexity:**

```
Exhaustive:     O(C × R × B)  where C=cities, R=RO levels, B=batch optimization
Beam Search:    O(W × D × B)  where W=beam width, D=depth, B=batch optimization

For our problem:
Exhaustive:     O(10 × 5 × 100) = O(5,000) operations
Beam Search:    O(50 × 10 × 100) = O(50,000) operations

Exhaustive is actually FASTER!
```

---

## Conclusion

**Beam search is NOT the right approach for this problem.**

The configuration space is small enough (~500 configs) that we can afford to:
1. Generate all configurations
2. Filter infeasible ones
3. Optimize batch allocation for remaining configs
4. Return the optimal solution

This approach is:
- ✅ Simpler to implement
- ✅ Faster to execute
- ✅ Easier to debug
- ✅ Guaranteed optimal
- ✅ No parameters to tune

**The real optimization challenge is batch allocation (L1-L5 distribution), not configuration search.**

---

## Recommended Sprint 2 Focus

Instead of beam search, focus on:

1. **Smart Configuration Filtering**
   - Early feasibility checks
   - Cost-based pruning
   - Dominance detection

2. **Batch Allocation Optimization**
   - Dynamic programming for L1-L5 distribution
   - Consider research timing constraints
   - Optimize for deadline + cost

3. **Multi-Objective Handling**
   - Pareto frontier for cost vs. time
   - Weighted scalarization
   - Constraint relaxation

This will deliver better results with less complexity!