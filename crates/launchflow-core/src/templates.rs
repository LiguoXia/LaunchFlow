//! A runnable Windows tutorial. Installation supplies device-local paths and an unused TCP port.
use crate::{model::*, registry::NodeRegistry};
use serde_json::{json, Value};

pub struct WindowsDemo {
    pub scenes: Vec<Scene>,
    pub profiles: Vec<ApplicationProfile>,
    pub secret_id: String,
}

fn append(
    scene: &mut Scene,
    kind: &str,
    name: &str,
    description: &str,
    overrides: Value,
) -> String {
    let mut config = NodeRegistry::builtins()
        .runner(kind)
        .expect("builtin template node")
        .definition()
        .defaults;
    config
        .as_object_mut()
        .unwrap()
        .extend(overrides.as_object().unwrap().clone());
    let mut node = Node::new(kind, name, config);
    node.description = description.into();
    let index = scene.workflow.nodes.len();
    node.position = Position {
        x: 80.,
        y: 80. + index as f64 * 160.,
    };
    node.metadata
        .insert("template".into(), json!("windows-demo-v1"));
    let node_id = node.id.clone();
    if let Some(previous) = scene.workflow.nodes.last() {
        scene.workflow.edges.push(Edge {
            id: id(),
            from: previous.id.clone(),
            to: node_id.clone(),
            outlet: if previous.node_type == "flow.condition" {
                "true"
            } else {
                "success"
            }
            .into(),
        });
    }
    scene.workflow.nodes.push(node);
    node_id
}

pub fn windows_demo(
    harness: &str,
    notepad: &str,
    powershell: &str,
    folder: &str,
    file: &str,
    port: u16,
) -> WindowsDemo {
    let mut main = Scene::new("Windows 全步骤体验");
    main.description = "内置入门模板 · 33 种步骤。运行前请保存手头工作并观察练习窗口；可在运行详情中取消。主场景和配套子场景可分别删除。".into();
    main.max_parallel = 1;
    let mut child = Scene::new("体验模板 · 子流程");
    child.description =
        "由「Windows 全步骤体验」调用：等待片刻后返回。请在删除主场景后再删除此子场景。".into();
    append(
        &mut child,
        "system.delay",
        "子流程：等待 300 毫秒",
        "在父运行详情打开子运行，查看独立快照和执行结果。",
        json!({"durationMs":300}),
    );
    let title = "LaunchFlow 步骤练习 · ${run.id}";
    let secret_id = format!("demo-{}", main.id);
    let profile = |name: &str, executable: &str, process_name: &str, arguments: Vec<String>| {
        ApplicationProfile {
            schema_version: 1,
            id: id(),
            display_name: name.into(),
            windows: WindowsBinding {
                executable: executable.into(),
                process_name: process_name.into(),
                ..Default::default()
            },
            macos: MacosBinding::default(),
            launch_arguments: arguments,
            ready_detection: None,
        }
    };
    let practice = profile(
        "模板 · 步骤练习窗口",
        harness,
        "launchflow-harness.exe",
        vec!["--tutorial".into(), main.id.clone(), port.to_string()],
    );
    let editor = profile("模板 · Windows 记事本", notepad, "notepad.exe", vec![]);
    let window = json!({"application":"launchflow-harness.exe","title":title});
    let gui = |target: &str, extra: Value| {
        let locator = if target.is_empty() {
            json!({"kind":"window","window":window})
        } else {
            json!({"kind":"accessibility","window":window,"automationId":target})
        };
        let mut config = json!({"locators":[locator],"pollIntervalMs":400,"captureOnFailure":true});
        config
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        config
    };
    append(
        &mut main,
        "application.launch",
        "05 · 启动步骤练习窗口",
        "随 LaunchFlow 提供的练习程序，无需安装第三方软件。每次运行重新打开本模板的练习窗口，使用本次运行 ID 定位。",
        json!({"applicationId":practice.id,"arguments":["${run.id}"],"alreadyRunning":"newInstance"}),
    );
    append(
        &mut main,
        "gui.waitWindow",
        "06 · 等待练习窗口",
        "以进程名和唯一窗口标题定位，不依赖屏幕坐标。",
        gui("", json!({})),
    );
    append(
        &mut main,
        "wait.port",
        "07 · 等待本机服务端口",
        "练习窗口提供仅监听 127.0.0.1 的网页服务；关闭练习窗口即停止。",
        json!({"host":"127.0.0.1","port":port}),
    );
    append(
        &mut main,
        "system.command",
        "09 · 执行普通用户命令",
        "Windows PowerShell 输出一行体验信息；在运行详情查看标准输出。",
        json!({"program":powershell,"arguments":["-NoProfile","-NonInteractive","-Command","Write-Output 'LaunchFlow demo is ready'"],"captureOutput":true}),
    );
    append(
        &mut main,
        "system.delay",
        "10 · 等待一秒",
        "留出观察时间。应用就绪检查优先使用进程、端口或窗口等待。",
        json!({"durationMs":1000}),
    );
    let condition = append(
        &mut main,
        "flow.condition",
        "11 · 判断当前系统",
        "Windows 走 true 分支；在高级画布和运行详情查看分支连线。",
        json!({"kind":"os","value":"windows"}),
    );
    append(
        &mut main,
        "flow.subflow",
        "12 · 执行配套子场景",
        "调用一个独立场景，并等待子场景完成。",
        json!({"sceneId":child.id}),
    );
    let join = append(
        &mut main,
        "flow.join",
        "13 · 汇合分支",
        "等待上游结束，至少一个有效分支到达后继续。",
        json!({}),
    );
    main.workflow.edges.push(Edge {
        id: id(),
        from: condition,
        to: join,
        outlet: "false".into(),
    });
    append(
        &mut main,
        "gui.activateWindow",
        "14 · 激活练习窗口",
        "后续输入只发送到这个模板的专用窗口。",
        gui("", json!({})),
    );
    append(
        &mut main,
        "gui.click",
        "15 · 点击 Start Task",
        "观察窗口中的 Task started 计数。",
        gui("start-button", json!({})),
    );
    append(
        &mut main,
        "gui.doubleClick",
        "16 · 双击 Start Task",
        "观察 Double click received 提示。",
        gui("start-button", json!({})),
    );
    append(
        &mut main,
        "gui.rightClick",
        "17 · 右键打开菜单",
        "显示 Start Task 的上下文菜单。",
        gui("start-button", json!({})),
    );
    append(
        &mut main,
        "gui.pressKey",
        "18 · Escape 关闭菜单",
        "向指定窗口发送单个按键。",
        gui("", json!({"key":"Escape"})),
    );
    append(
        &mut main,
        "clipboard.copyText",
        "复制后续输入文本到剪贴板",
        "只填写要复制的文本即可；可把后续输入步骤替换成定位输入框后 Ctrl+V 粘贴。",
        json!({"text":"你好，LaunchFlow！"}),
    );
    append(
        &mut main,
        "gui.inputText",
        "19 · 输入中文文本",
        "在 Project name 中输入中文；可编辑 text 参数体验其他内容。",
        gui("project-input", json!({"text":"你好，LaunchFlow！"})),
    );
    append(
        &mut main,
        "gui.inputSecret",
        "20 · 输入演示 Secret",
        "从系统凭据管理器读取模板专用演示值；场景只保存引用。可在权限与凭据页面删除演示凭据。",
        gui(
            "password-input",
            json!({"secretRef":format!("vault:{secret_id}")}),
        ),
    );
    append(
        &mut main,
        "gui.selectOption",
        "21 · 选择 Staging",
        "下拉框 Environment 改为 Staging。",
        gui("environment-choice", json!({"option":"Staging"})),
    );
    append(
        &mut main,
        "gui.shortcut",
        "22 · Ctrl+Enter 提交",
        "组合快捷键提交表单，结果区显示中文文本和所选环境。",
        gui("", json!({"keys":["Control","Enter"]})),
    );
    append(
        &mut main,
        "gui.selectMenu",
        "23 · File → Open Dialog",
        "按菜单路径打开练习对话框。",
        gui("", json!({"menuPath":["File","Open Dialog"]})),
    );
    let dialog =
        json!({"application":"launchflow-harness.exe","title":format!("{title} · Dialog")});
    append(
        &mut main,
        "gui.waitWindow",
        "24 · 等待对话框",
        "等待菜单打开的新窗口。",
        json!({"locators":[{"kind":"window","window":dialog}]}),
    );
    append(
        &mut main,
        "gui.click",
        "25 · 确认练习对话框",
        "点击 Confirm Dialog 后返回练习窗口。",
        json!({"locators":[{"kind":"accessibility","window":dialog,"automationId":"confirm-dialog"}]}),
    );
    append(
        &mut main,
        "gui.click",
        "26 · 触发延迟出现的元素",
        "650 毫秒后出现 Dynamic element。",
        gui("dynamic-button", json!({})),
    );
    append(
        &mut main,
        "gui.waitElement",
        "27 · 等待动态元素",
        "轮询目标控件，出现后立即继续。",
        gui("dynamic-element", json!({})),
    );
    append(
        &mut main,
        "gui.click",
        "28 · 移除动态元素",
        "点击后该控件会消失。",
        gui("dynamic-element", json!({})),
    );
    append(
        &mut main,
        "gui.waitElementDisappear",
        "29 · 等待元素消失",
        "确认动态控件已不在窗口中。",
        gui("dynamic-element", json!({})),
    );
    append(
        &mut main,
        "gui.scroll",
        "30 · 向下滚动",
        "显示练习窗口下部的拖动区域。",
        gui("scroll-area", json!({"delta":8})),
    );
    let drag = append(
        &mut main,
        "gui.waitElement",
        "31 · 获取拖动目标",
        "本步骤输出控件的实际位置，供下一步引用，适应显示缩放。",
        gui("drag-target", json!({})),
    );
    append(
        &mut main,
        "gui.drag",
        "32 · 拖动色块",
        "从色块中心拖向其左上角；终点引用上一步的实时坐标。",
        gui(
            "drag-target",
            json!({"endX":format!("${{node.{drag}.output.automation.matchedElement.bounds.x}}"),"endY":format!("${{node.{drag}.output.automation.matchedElement.bounds.y}}")}),
        ),
    );
    append(
        &mut main,
        "gui.scroll",
        "33 · 滚回表单顶部",
        "观察 Drag received 结果。",
        gui("scroll-area", json!({"delta":-20})),
    );
    append(
        &mut main,
        "gui.moveWindow",
        "34 · 移动练习窗口",
        "把练习窗口移到屏幕左上区域。",
        gui("", json!({"x":80,"y":60})),
    );
    append(
        &mut main,
        "gui.resizeWindow",
        "35 · 调整窗口大小",
        "把练习窗口调整为 820 × 720。",
        gui("", json!({"width":820,"height":720})),
    );
    append(
        &mut main,
        "gui.maximize",
        "36 · 最大化",
        "观察练习窗口占满工作区。",
        gui("", json!({})),
    );
    append(
        &mut main,
        "system.delay",
        "37 · 观察最大化效果",
        "稍作停留，便于观察窗口变化。",
        json!({"durationMs":800}),
    );
    append(
        &mut main,
        "gui.minimize",
        "38 · 最小化",
        "练习窗口收进任务栏。",
        gui("", json!({})),
    );
    append(
        &mut main,
        "system.delay",
        "39 · 观察最小化效果",
        "稍作停留后恢复窗口。",
        json!({"durationMs":800}),
    );
    append(
        &mut main,
        "gui.activateWindow",
        "40 · 恢复练习窗口",
        "将最小化的窗口重新激活。",
        gui("", json!({})),
    );
    let area = json!({"x":0,"y":0,"width":1920,"height":1040});
    append(
        &mut main,
        "workspace.restore",
        "41 · 恢复工作区布局",
        "按主显示器可用区域比例恢复练习窗口，不移动其他应用。",
        json!({"mode":"relative","skipMissingWindows":false,"profiles":[{"name":"练习布局","condition":{},"windows":[{"applicationId":practice.id,"identity":window,"display":{"id":"","name":"","bounds":area,"workArea":area,"scale":1,"primary":true},"bounds":{"x":100,"y":60,"width":900,"height":740},"relative":{"x":0.12,"y":0.08,"width":0.65,"height":0.82},"state":"normal"}]}]}),
    );
    append(
        &mut main,
        "gui.screenshot",
        "42 · 保存练习窗口截图",
        "GUI 体验完成！在此步骤的诊断附件查看截图，接下来体验 Windows 默认应用。",
        gui("", json!({})),
    );
    // Shell dispatch can return before Explorer/Notepad actually takes foreground.
    // Keep every external window launch after the tutorial's GUI input sequence.
    append(
        &mut main,
        "application.launch",
        "启动记事本",
        "打开模板说明文件，不修改已有笔记。",
        json!({"applicationId":editor.id,"arguments":[file],"alreadyRunning":"newInstance"}),
    );
    append(
        &mut main,
        "wait.process",
        "等待记事本进程",
        "等待进程出现后才继续，比固定延时更可靠。",
        json!({"processName":"notepad.exe"}),
    );
    append(
        &mut main,
        "application.open.file",
        "用默认应用打开说明",
        "使用 Windows 的 .txt 文件关联；可以与上一步比较。",
        json!({"target":file}),
    );
    append(
        &mut main,
        "application.open.folder",
        "打开体验文件夹",
        "在资源管理器查看此模板的本地说明文件。",
        json!({"target":folder}),
    );
    append(
        &mut main,
        "application.open.url",
        "打开本地体验网页",
        "完成！默认浏览器打开本机体验说明，不访问互联网。",
        json!({"target":format!("http://127.0.0.1:{port}/")}),
    );
    for (index, node) in main.workflow.nodes.iter_mut().enumerate() {
        let label = node
            .name
            .split_once(" · ")
            .map_or(node.name.as_str(), |(_, label)| label);
        node.name = format!("{:02} · {label}", index + 1);
    }
    WindowsDemo {
        scenes: vec![main, child],
        profiles: vec![editor, practice],
        secret_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tutorial_covers_every_builtin_with_valid_connected_graphs() {
        let demo = windows_demo(
            "C:\\demo\\harness.exe",
            "C:\\Windows\\notepad.exe",
            "powershell.exe",
            "C:\\demo",
            "C:\\demo\\readme.txt",
            19000,
        );
        let registry = NodeRegistry::builtins();
        let kinds: std::collections::BTreeSet<_> = demo
            .scenes
            .iter()
            .flat_map(|s| s.workflow.nodes.iter().map(|n| n.node_type.clone()))
            .collect();
        assert_eq!(
            kinds,
            registry
                .definitions()
                .into_iter()
                .map(|d| d.node_type)
                .collect()
        );
        for scene in &demo.scenes {
            let issues = crate::validation::validate_scene(
                scene,
                &registry,
                &demo.profiles,
                "windows",
                true,
            );
            assert!(issues.is_empty(), "{issues:?}");
            assert!(!scene.is_default);
            assert!(scene.triggers.is_empty());
            let order = crate::validation::graph_order(&scene.workflow).unwrap();
            assert_eq!(order.len(), scene.workflow.nodes.len());
            for node in scene.workflow.nodes.iter().skip(1) {
                assert!(crate::validation::ancestors(&scene.workflow, &node.id).contains(&order[0]));
            }
        }
        assert_eq!(
            demo.scenes[0]
                .workflow
                .nodes
                .iter()
                .find(|n| n.node_type == "flow.subflow")
                .unwrap()
                .config["sceneId"],
            demo.scenes[1].id
        );
    }
}
