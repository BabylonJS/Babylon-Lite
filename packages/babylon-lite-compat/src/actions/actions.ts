/**
 * Babylon.js-compatible Actions: `ActionManager`, `Action`, the common concrete
 * actions, and `Condition` variants.
 *
 * This is the structural/behavioural surface in pure JS. Triggers are not yet
 * auto-wired to Babylon Lite's input pipeline (that needs a unified pointer
 * pipe — see `COMPAT-STATUS.md`), so actions are dispatched manually via
 * `ActionManager.processTrigger(trigger)`. The action/condition execution model
 * itself is fully implemented and testable.
 */

/** Babylon.js `ActionManager` trigger constants (subset). */
export const ActionManagerTriggers = {
    NothingTrigger: 0,
    OnPickTrigger: 1,
    OnLeftPickTrigger: 2,
    OnRightPickTrigger: 3,
    OnCenterPickTrigger: 4,
    OnPickDownTrigger: 5,
    OnDoublePickTrigger: 6,
    OnPickUpTrigger: 7,
    OnPickOutTrigger: 16,
    OnPointerOverTrigger: 10,
    OnPointerOutTrigger: 11,
    OnEveryFrameTrigger: 14,
} as const;

interface ActionEvent {
    source: unknown;
    pointerX: number;
    pointerY: number;
    meshUnderPointer: unknown;
    additionalData?: unknown;
}

/** Base class for actions. `execute` is implemented by subclasses. */
export abstract class Action {
    public trigger: number;
    /** Condition gating execution. When set, `execute` runs only if it evaluates true. */
    public condition: Condition | undefined;

    private _nextActiveAction: Action | null = null;

    public constructor(trigger: number, condition?: Condition) {
        this.trigger = trigger;
        this.condition = condition;
    }

    public abstract execute(evt?: ActionEvent): void;

    /** Chain another action to run after this one (Babylon.js `then`). */
    public then(action: Action): Action {
        this._nextActiveAction = action;
        return action;
    }

    /** @internal Run this action (honouring its condition) and any chained action. */
    public _executeCurrent(evt?: ActionEvent): void {
        if (this.condition && !this.condition.isValid()) {
            return;
        }
        this.execute(evt);
        this._nextActiveAction?._executeCurrent(evt);
    }
}

/** Runs a user callback when triggered. */
export class ExecuteCodeAction extends Action {
    public constructor(
        trigger: number,
        private readonly _func: (evt?: ActionEvent) => void,
        condition?: Condition
    ) {
        super(trigger, condition);
    }

    public execute(evt?: ActionEvent): void {
        this._func(evt);
    }
}

/** Sets `target[propertyPath] = value` when triggered. */
export class SetValueAction extends Action {
    public constructor(
        trigger: number,
        private readonly _target: Record<string, unknown>,
        private readonly _propertyPath: string,
        private readonly _value: unknown,
        condition?: Condition
    ) {
        super(trigger, condition);
    }

    public execute(): void {
        setByPath(this._target, this._propertyPath, this._value);
    }
}

/** Adds `value` to `target[propertyPath]` when triggered. */
export class IncrementValueAction extends Action {
    public constructor(
        trigger: number,
        private readonly _target: Record<string, unknown>,
        private readonly _propertyPath: string,
        private readonly _value: number,
        condition?: Condition
    ) {
        super(trigger, condition);
    }

    public execute(): void {
        const current = getByPath(this._target, this._propertyPath);
        if (typeof current === "number") {
            setByPath(this._target, this._propertyPath, current + this._value);
        }
    }
}

/** Base class for action conditions. */
export abstract class Condition {
    public abstract isValid(): boolean;
}

export const ValueConditionOperators = {
    IsEqual: 0,
    IsDifferent: 1,
    IsGreater: 2,
    IsLesser: 3,
} as const;

/** Compares `target[propertyPath]` against a value with an operator. */
export class ValueCondition extends Condition {
    public constructor(
        private readonly _target: Record<string, unknown>,
        private readonly _propertyPath: string,
        private readonly _value: number,
        private readonly _operator: number = ValueConditionOperators.IsEqual
    ) {
        super();
    }

    public isValid(): boolean {
        const current = getByPath(this._target, this._propertyPath);
        if (typeof current !== "number") {
            return false;
        }
        switch (this._operator) {
            case ValueConditionOperators.IsEqual:
                return current === this._value;
            case ValueConditionOperators.IsDifferent:
                return current !== this._value;
            case ValueConditionOperators.IsGreater:
                return current > this._value;
            case ValueConditionOperators.IsLesser:
                return current < this._value;
            default:
                return false;
        }
    }
}

/** Evaluates a user predicate. */
export class PredicateCondition extends Condition {
    public constructor(private readonly _predicate: () => boolean) {
        super();
    }

    public isValid(): boolean {
        return this._predicate();
    }
}

/**
 * Babylon.js `ActionManager`. Register actions with `registerAction`, then
 * dispatch them with `processTrigger(trigger, evt?)`. (Automatic trigger
 * dispatch from input is not yet wired — see module docs.)
 */
export class ActionManager {
    public static readonly Triggers = ActionManagerTriggers;

    public readonly actions: Action[] = [];

    public registerAction(action: Action): Action {
        this.actions.push(action);
        return action;
    }

    public unregisterAction(action: Action): boolean {
        const index = this.actions.indexOf(action);
        if (index !== -1) {
            this.actions.splice(index, 1);
            return true;
        }
        return false;
    }

    public hasSpecificTrigger(trigger: number): boolean {
        return this.actions.some((a) => a.trigger === trigger);
    }

    /** Dispatch every registered action matching `trigger`. */
    public processTrigger(trigger: number, evt?: ActionEvent): void {
        for (const action of this.actions) {
            if (action.trigger === trigger) {
                action._executeCurrent(evt);
            }
        }
    }
}

function getByPath(target: Record<string, unknown>, path: string): unknown {
    const parts = path.split(".");
    let current: unknown = target;
    for (const part of parts) {
        if (current == null || typeof current !== "object") {
            return undefined;
        }
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}

function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split(".");
    let current: Record<string, unknown> = target;
    for (let i = 0; i < parts.length - 1; i++) {
        current = current[parts[i]!] as Record<string, unknown>;
        if (current == null) {
            return;
        }
    }
    current[parts[parts.length - 1]!] = value;
}
