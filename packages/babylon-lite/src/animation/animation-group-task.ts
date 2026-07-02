import { tickAnimation } from "./animation-tick.js";
import type { AnimationGroup } from "./animation-group.js";
import { addAnimationTask, createAnimationTask, removeAnimationTask } from "./animation-manager.js";
import type { AnimationManager, AnimationTask } from "./animation-manager.js";

export const ANIMATION_GROUP_TASK_CATEGORY = "animation-group";

interface AnimationGroupTaskManager extends AnimationManager {
    _animationGroups?: AnimationGroup[];
}

interface AnimationGroupTaskGroup extends AnimationGroup {
    _animationManager?: AnimationManager;
    _animationTask?: AnimationTask;
}

function getMutableAnimationGroups(manager: AnimationManager): AnimationGroup[] {
    const managerInternal = manager as AnimationGroupTaskManager;
    let groups = managerInternal._animationGroups;
    if (!groups) {
        groups = [];
        managerInternal._animationGroups = groups;
    }
    return groups;
}

/** Returns the animation groups currently attached to `manager`, or an empty array if none. */
export function getAnimationGroups(manager: AnimationManager): readonly AnimationGroup[] {
    return (manager as AnimationGroupTaskManager)._animationGroups ?? [];
}

export function getAnimationGroupOwner(group: AnimationGroup): AnimationManager | undefined {
    return (group as AnimationGroupTaskGroup)._animationManager;
}

/** Attaches `group` to `manager` so it is ticked each update, creating its backing animation task on first use.
 *  @param manager - Animation manager that will own and drive the group.
 *  @param group - Animation group to attach.
 *  @throws If the group is already attached to a different manager. */
export function addAnimationGroup(manager: AnimationManager, group: AnimationGroup): void {
    const groupInternal = group as AnimationGroupTaskGroup;
    const owner = groupInternal._animationManager;
    if (owner && owner !== manager) {
        throw new Error(`AnimationGroup "${group.name}" is already attached to another AnimationManager`);
    }
    if (owner === manager) {
        return;
    }
    const task =
        groupInternal._animationTask ??
        createAnimationTask(
            (taskManager, deltaMs) => {
                tickAnimation(group, deltaMs, taskManager.engine);
            },
            {
                category: ANIMATION_GROUP_TASK_CATEGORY,
                dispose: (ownerManager) => {
                    const groups = (ownerManager as AnimationGroupTaskManager)._animationGroups;
                    const index = groups?.indexOf(group) ?? -1;
                    if (groups && index !== -1) {
                        groups.splice(index, 1);
                    }
                    if (groupInternal._animationManager === ownerManager) {
                        groupInternal._animationManager = undefined;
                    }
                },
            }
        );
    getMutableAnimationGroups(manager).push(group);
    groupInternal._animationManager = manager;
    groupInternal._animationTask = task;
    addAnimationTask(manager, task);
}

/** Attaches each group in `groups` to `manager` via {@link addAnimationGroup}. */
export function addAnimationGroups(manager: AnimationManager, groups: readonly AnimationGroup[]): void {
    for (const group of groups) {
        addAnimationGroup(manager, group);
    }
}

/** Detaches `group` from `manager`, removing its animation task so it is no longer ticked. */
export function removeAnimationGroup(manager: AnimationManager, group: AnimationGroup): void {
    const groupInternal = group as AnimationGroupTaskGroup;
    const task = groupInternal._animationTask;
    if (task && groupInternal._animationManager === manager) {
        removeAnimationTask(manager, task);
        return;
    }
    const groups = (manager as AnimationGroupTaskManager)._animationGroups;
    const index = groups?.indexOf(group) ?? -1;
    if (groups && index !== -1) {
        groups.splice(index, 1);
    }
    if (groupInternal._animationManager === manager) {
        groupInternal._animationManager = undefined;
    }
}
