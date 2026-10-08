import type { WorkflowNode } from '../domain/types';
import { useWorkspace } from '../lib/workspace';
import ApplicationIcon from './ApplicationIcon';
import { NodeIcon } from './ui';

export default function WorkflowNodeIcon({
  node,
  size = 22,
}: {
  node: WorkflowNode;
  size?: number;
}) {
  const { data } = useWorkspace();
  const profile = data.profiles.find((p) => p.id === node.config.applicationId);
  return profile ? (
    <ApplicationIcon
      profile={profile}
      size={size}
      fallback={<NodeIcon type={node.type} size={size} />}
    />
  ) : (
    <NodeIcon type={node.type} size={size} />
  );
}
