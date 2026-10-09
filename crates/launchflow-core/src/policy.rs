use crate::{model::*, Error, Result};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SensitiveActionPolicy {
    AskEveryTime,
    AllowForThisScene,
    #[default]
    BlockAtStartup,
}
pub fn sensitive(node: &Node) -> bool {
    node.enabled
        && (node.node_type == "system.command"
            || node.node_type == "gui.inputSecret"
            || (node.node_type == "flow.condition" && node.config["kind"] == "command")
            || (node.node_type.starts_with("gui.")
                && ![
                    "gui.waitWindow",
                    "gui.waitElement",
                    "gui.waitElementDisappear",
                    "gui.screenshot",
                    "gui.activateWindow",
                    "gui.moveWindow",
                    "gui.resizeWindow",
                    "gui.minimizeWindow",
                    "gui.maximizeWindow",
                ]
                .contains(&node.node_type.as_str())))
}
pub fn check<'a>(
    scenes: impl Iterator<Item = &'a Scene>,
    source: &str,
    approved: bool,
) -> Result<()> {
    for scene in scenes {
        if !scene.workflow.nodes.iter().any(sensitive) {
            continue;
        }
        match scene.sensitive_action_policy {
            SensitiveActionPolicy::AskEveryTime if !approved => return Err(Error::Validation(
                "sensitiveApprovalRequired: Review and confirm the sensitive actions for this run."
                    .into(),
            )),
            SensitiveActionPolicy::BlockAtStartup
                if ["startup", "systemLogin", "appStarted"].contains(&source) =>
            {
                return Err(Error::Validation(
                    "startupPolicyBlocked: 默认场景或子场景的策略阻止自动执行。请到设置 → 启动与后台，允许此场景自动执行；点击、文本输入、命令和密码输入均受此策略控制。".into(),
                ))
            }
            _ => {}
        }
    }
    Ok(())
}
