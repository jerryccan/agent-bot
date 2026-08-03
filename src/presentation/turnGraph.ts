export interface TurnGraphNode {
  turnId: string;
  parentTurnId?: string;
}

export interface TurnGraphRow {
  sequence: number;
  nodeLine: string;
  connectorLine?: string;
}

export function buildTurnGraphRows(nodes: readonly TurnGraphNode[]): TurnGraphRow[] {
  const visibleTurnIds = new Set(nodes.map((node) => node.turnId));
  const lanes: string[] = [];

  return nodes.map((node, index) => {
    let lane = lanes.indexOf(node.turnId);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(node.turnId);
    }

    const sequence = index + 1;
    const nodeLine = `${lanes.map((_, laneIndex) => laneIndex === lane ? "●" : "│").join(" ")} ${sequence}`;
    const parentTurnId = node.parentTurnId && visibleTurnIds.has(node.parentTurnId)
      ? node.parentTurnId
      : undefined;
    let connectorLine: string | undefined;

    if (!parentTurnId) {
      lanes.splice(lane, 1);
      connectorLine = lanes.length > 0 ? lanes.map(() => "│").join(" ") : undefined;
    } else {
      const existingParentLane = lanes.indexOf(parentTurnId);
      if (existingParentLane < 0 || existingParentLane === lane) {
        lanes[lane] = parentTurnId;
        connectorLine = lanes.map(() => "│").join(" ");
      } else {
        const connectorLanes = lanes.map(() => "│");
        connectorLanes[lane] = lane > existingParentLane ? "╱" : "╲";
        connectorLine = connectorLanes.join(" ");
        lanes.splice(lane, 1);
      }
    }

    return { sequence, nodeLine, ...(connectorLine ? { connectorLine } : {}) };
  });
}
