import {
  EventObject,
  AnyStateMachine,
  StateMachine,
  AnyActorLogic,
  EventFromLogic,
  Snapshot,
  __unsafe_getAllOwnEventDescriptors,
  InputFrom
} from '../index.ts';
import type {
  SerializedEvent,
  SerializedSnapshot,
  StatePath,
  DirectedGraphEdge,
  DirectedGraphNode,
  TraversalOptions,
  AnyStateNode,
  TraversalConfig
} from './types.ts';
import { createMockActorScope } from './actorScope.ts';

/**
 * Returns all state nodes of the given `node`.
 *
 * @param stateNode State node to recursively get child state nodes from
 */
export function getStateNodes(
  stateNode: AnyStateNode | AnyStateMachine
): AnyStateNode[] {
  const { states } = stateNode;
  const nodes = Object.keys(states).reduce((accNodes, stateKey) => {
    const childStateNode = states[stateKey];
    const childStateNodes = getStateNodes(childStateNode);

    accNodes.push(childStateNode, ...childStateNodes);
    return accNodes;
  }, [] as AnyStateNode[]);

  return nodes;
}

function getChildren(stateNode: AnyStateNode): AnyStateNode[] {
  if (!stateNode.states) {
    return [];
  }

  const children = Object.keys(stateNode.states).map((key) => {
    return stateNode.states[key];
  });

  return children;
}

export function serializeSnapshot(snapshot: Snapshot<any>): SerializedSnapshot {
  const { value, context } = snapshot as any;
  return JSON.stringify({
    value,
    context: Object.keys(context ?? {}).length ? context : undefined
  }) as SerializedSnapshot;
}

function serializeEvent<TEvent extends EventObject>(
  event: TEvent
): SerializedEvent {
  return JSON.stringify(event) as SerializedEvent;
}

export function createDefaultMachineOptions<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options?: TraversalOptions<
    ReturnType<TMachine['transition']>,
    EventFromLogic<TMachine>,
    InputFrom<TMachine>
  >
): TraversalOptions<
  ReturnType<TMachine['transition']>,
  EventFromLogic<TMachine>,
  InputFrom<TMachine>
> {
  const { events: getEvents, ...otherOptions } = options ?? {};
  const traversalOptions: TraversalOptions<
    ReturnType<TMachine['transition']>,
    EventFromLogic<TMachine>,
    InputFrom<TMachine>
  > = {
    serializeState: serializeSnapshot,
    serializeEvent,
    events: (state) => {
      const events =
        typeof getEvents === 'function' ? getEvents(state) : (getEvents ?? []);
      return __unsafe_getAllOwnEventDescriptors(state).flatMap((type) => {
        const matchingEvents = events.filter((ev) => (ev as any).type === type);
        if (matchingEvents.length) {
          return matchingEvents;
        }
        return [{ type }];
      }) as any[];
    },
    fromState: machine.getInitialSnapshot(
      createMockActorScope(),
      options?.input
    ) as ReturnType<TMachine['transition']>,
    ...otherOptions
  };

  return traversalOptions;
}

export function createDefaultLogicOptions(): TraversalOptions<any, any, any> {
  return {
    serializeState: (state) => JSON.stringify(state),
    serializeEvent
  };
}

export function toDirectedGraph(
  stateMachine: AnyStateNode | AnyStateMachine
): DirectedGraphNode {
  const stateNode =
    stateMachine instanceof StateMachine ? stateMachine.root : stateMachine; // TODO: accept only machines

  const edges: DirectedGraphEdge[] = [...stateNode.transitions.values()]
    .flat()
    .flatMap((t, transitionIndex) => {
      const targets = t.target ? t.target : [stateNode];

      return targets.map((target, targetIndex) => {
        const edge: DirectedGraphEdge = {
          id: `${stateNode.id}:${transitionIndex}:${targetIndex}`,
          source: stateNode,
          target: target as AnyStateNode,
          transition: t,
          label: {
            text: t.eventType,
            toJSON: () => ({ text: t.eventType })
          },
          toJSON: () => {
            const { label } = edge;

            return { source: stateNode.id, target: target.id, label };
          }
        };

        return edge;
      });
    });

  const graph = {
    id: stateNode.id,
    stateNode: stateNode,
    children: getChildren(stateNode).map(toDirectedGraph),
    edges,
    toJSON: () => {
      const { id, children, edges: graphEdges } = graph;
      return { id, children, edges: graphEdges };
    }
  };

  return graph;
}

function isMachineLogic(logic: AnyActorLogic): logic is AnyStateMachine {
  return 'getStateNodeById' in logic;
}

export function resolveTraversalOptions<TLogic extends AnyActorLogic>(
  logic: TLogic,
  traversalOptions?: TraversalOptions<
    ReturnType<TLogic['transition']>,
    EventFromLogic<TLogic>,
    InputFrom<TLogic>
  >,
  defaultOptions?: TraversalOptions<
    ReturnType<TLogic['transition']>,
    EventFromLogic<TLogic>,
    InputFrom<TLogic>
  >
): TraversalConfig<ReturnType<TLogic['transition']>, EventFromLogic<TLogic>> {
  const resolvedDefaultOptions =
    defaultOptions ??
    (isMachineLogic(logic)
      ? (createDefaultMachineOptions(
          logic,
          traversalOptions as any
        ) as TraversalOptions<
          ReturnType<TLogic['transition']>,
          EventFromLogic<TLogic>,
          InputFrom<TLogic>
        >)
      : undefined);
  const serializeState =
    traversalOptions?.serializeState ??
    resolvedDefaultOptions?.serializeState ??
    ((state) => JSON.stringify(state));
  const traversalConfig: TraversalConfig<
    ReturnType<TLogic['transition']>,
    EventFromLogic<TLogic>
  > = {
    serializeState,
    serializeEvent,
    events: [],
    limit: Infinity,
    fromState: undefined,
    toState: undefined,
    // Traversal should not continue past the `toState` predicate
    // since the target state has already been reached at that point
    stopWhen: traversalOptions?.toState,
    ...resolvedDefaultOptions,
    ...traversalOptions
  };

  return traversalConfig;
}

export function joinPaths<
  TSnapshot extends Snapshot<unknown>,
  TEvent extends EventObject
>(
  headPath: StatePath<TSnapshot, TEvent>,
  tailPath: StatePath<TSnapshot, TEvent>
): StatePath<TSnapshot, TEvent> {
  const secondPathSource = tailPath.steps[0].state;

  if (secondPathSource !== headPath.state) {
    throw new Error(`Paths cannot be joined`);
  }

  return {
    state: tailPath.state,
    // e.g. [A, B, C] + [C, D, E] = [A, B, C, D, E]
    steps: headPath.steps.concat(tailPath.steps.slice(1)),
    weight: headPath.weight + tailPath.weight
  };
}
