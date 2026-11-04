import { describe, expect, it, vi } from "vitest";

import {
    ActionManager,
    ExecuteCodeAction,
    SetValueAction,
    IncrementValueAction,
    ValueCondition,
    PredicateCondition,
    ValueConditionOperators,
    ActionManagerTriggers,
} from "../src/actions/actions";

describe("ActionManager", () => {
    it("dispatches actions matching a trigger", () => {
        const manager = new ActionManager();
        const fn = vi.fn();
        manager.registerAction(new ExecuteCodeAction(ActionManagerTriggers.OnPickTrigger, fn));
        manager.processTrigger(ActionManagerTriggers.OnPickTrigger);
        expect(fn).toHaveBeenCalledTimes(1);
        // A different trigger does not fire it.
        manager.processTrigger(ActionManagerTriggers.OnPointerOverTrigger);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("exposes triggers as a static and reports specific triggers", () => {
        expect(ActionManager.Triggers.OnPickTrigger).toBe(1);
        const manager = new ActionManager();
        manager.registerAction(new ExecuteCodeAction(ActionManagerTriggers.OnPickTrigger, () => {}));
        expect(manager.hasSpecificTrigger(ActionManagerTriggers.OnPickTrigger)).toBe(true);
        expect(manager.hasSpecificTrigger(ActionManagerTriggers.OnPickUpTrigger)).toBe(false);
    });
});

describe("Actions", () => {
    it("SetValueAction assigns a nested property", () => {
        const target = { material: { alpha: 1 } };
        const manager = new ActionManager();
        manager.registerAction(new SetValueAction(ActionManagerTriggers.OnPickTrigger, target, "material.alpha", 0.5));
        manager.processTrigger(ActionManagerTriggers.OnPickTrigger);
        expect(target.material.alpha).toBe(0.5);
    });

    it("IncrementValueAction adds to a numeric property", () => {
        const target = { count: 10 };
        const manager = new ActionManager();
        manager.registerAction(new IncrementValueAction(ActionManagerTriggers.OnPickTrigger, target, "count", 5));
        manager.processTrigger(ActionManagerTriggers.OnPickTrigger);
        expect(target.count).toBe(15);
    });

    it("chains actions with then()", () => {
        const order: number[] = [];
        const manager = new ActionManager();
        const first = new ExecuteCodeAction(ActionManagerTriggers.OnPickTrigger, () => order.push(1));
        first.then(new ExecuteCodeAction(ActionManagerTriggers.OnPickTrigger, () => order.push(2)));
        manager.registerAction(first);
        manager.processTrigger(ActionManagerTriggers.OnPickTrigger);
        expect(order).toEqual([1, 2]);
    });
});

describe("Conditions", () => {
    it("ValueCondition gates execution", () => {
        const target = { count: 3 };
        const fn = vi.fn();
        const manager = new ActionManager();
        manager.registerAction(new ExecuteCodeAction(ActionManagerTriggers.OnPickTrigger, fn, new ValueCondition(target, "count", 3, ValueConditionOperators.IsEqual)));
        manager.processTrigger(ActionManagerTriggers.OnPickTrigger);
        expect(fn).toHaveBeenCalledTimes(1);

        target.count = 4;
        manager.processTrigger(ActionManagerTriggers.OnPickTrigger);
        expect(fn).toHaveBeenCalledTimes(1); // condition now false
    });

    it("PredicateCondition evaluates a function", () => {
        let allow = false;
        const fn = vi.fn();
        const manager = new ActionManager();
        manager.registerAction(new ExecuteCodeAction(ActionManagerTriggers.OnPickTrigger, fn, new PredicateCondition(() => allow)));
        manager.processTrigger(ActionManagerTriggers.OnPickTrigger);
        expect(fn).not.toHaveBeenCalled();
        allow = true;
        manager.processTrigger(ActionManagerTriggers.OnPickTrigger);
        expect(fn).toHaveBeenCalledTimes(1);
    });
});
