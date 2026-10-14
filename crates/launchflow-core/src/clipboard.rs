use crate::{
    automation::runner::desktop_lock,
    registry::{definition, field, NodeContext, NodeDefinition, NodeOutput, NodeRunner},
    Error, Result,
};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

pub struct CopyTextRunner;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    text: String,
}
fn config(value: &Value) -> Result<Config> {
    let config: Config = serde_json::from_value(value.clone())?;
    if config.text.is_empty() || config.text.len() > 131_072 || config.text.contains('\0') {
        return Err(Error::Validation(
            "请输入需要复制的文本（最多 128 KiB，不能包含 NUL 字符）".into(),
        ));
    }
    Ok(config)
}
#[async_trait]
impl NodeRunner for CopyTextRunner {
    fn definition(&self) -> NodeDefinition {
        definition(
            "clipboard.copyText",
            "复制文本",
            "将文本复制到系统剪贴板，后续可用组合快捷键粘贴",
            "system",
            vec![field(
                "text",
                "需要复制的文本",
                "textarea",
                true,
                "保留换行和空格；后续添加组合快捷键 Ctrl+V（Windows）或 Command+V（macOS）",
            )],
            json!({"text":""}),
            false,
        )
    }
    fn validate(&self, value: &Value) -> Result<()> {
        config(value).map(|_| ())
    }
    async fn run(&self, value: &Value, ctx: &NodeContext) -> Result<NodeOutput> {
        let config = config(value)?;
        let _guard = desktop_lock()
            .acquire()
            .await
            .map_err(|_| Error::Runtime("Desktop input service unavailable".into()))?;
        if !ctx.platform.desktop_ready() {
            return Err(Error::DesktopUnavailable);
        }
        ctx.platform
            .automation()
            .request(json!({"op":"clipboardCopyText","text":config.text}))
            .await
            .map_err(|error| Error::Runtime(format!("复制到剪贴板失败：{error}")))?;
        Ok(NodeOutput {
            message: "文本已复制到剪贴板".into(),
            output: json!({"copied":true,"characters":config.text.chars().count()}),
            ..Default::default()
        })
    }
}
