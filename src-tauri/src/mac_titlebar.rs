//! macOS Overlay 标题栏复位。
//!
//! 背景:`tauri.conf.json` 用 `titleBarStyle: "Overlay"` + `hiddenTitle` +
//! `trafficLightPosition` 让窗口保留原生边框/圆角/阴影与交通灯,同时把 webview
//! 内容铺满整窗、由前端自绘 48px 顶部工具栏(左侧用 `pl-[72px]` 给交通灯让位)。
//!
//! 问题:macOS 在窗口几何变化(进入/退出全屏、双击缩放 zoom、最小化后恢复、
//! 拖拽 resize)后会重排原生标题栏——`trafficLightPosition` 只在窗口创建时生效
//! 一次(见 tauri-apps/tauri#13044),FullSizeContentView / titlebarAppearsTransparent
//! 也可能被重置,导致自绘的顶部工具栏被顶出可视区、交通灯压到内容上。
//!
//! 方案:每次窗口几何事件后,在主线程重申标题栏样式位并把交通灯复位到既定内
//! 嵌位置。定位数学移植自社区验证过的 tauri-plugin-decorum / Hoppscotch 实现,
//! 用现代 objc2 类型化 API 重写(不做 NSWindowDelegate 运行时子类化)。

#![cfg(target_os = "macos")]

use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};
use objc2_foundation::NSPoint;

// 交通灯内嵌参数(可按视觉微调):
// PAD_X —— close 按钮左边距(px)。与前端 `pl-[72px]` 让位区匹配。
const TRAFFIC_LIGHT_PAD_X: f64 = 19.0;
// PAD_Y —— 参与标题栏容器高度计算,配合 VERTICAL_OFFSET 决定按钮竖直位置。
const TRAFFIC_LIGHT_PAD_Y: f64 = 16.0;
// 三个按钮之间的水平间距(px)。
const BUTTON_SPACING: f64 = 20.0;
// 竖直微调:数值越大按钮越靠下。针对 48px 顶部栏调过,使按钮竖直居中于该栏。
const VERTICAL_OFFSET: f64 = 8.0;

/// 把 Tauri 给的 `*mut c_void` 当作 `&NSWindow` 使用。
///
/// # Safety
/// 调用方必须保证 `ptr` 是有效的、当前存活的 NSWindow 指针,且本调用发生在主线程。
unsafe fn ns_window_from_ptr<'a>(ptr: *mut std::ffi::c_void) -> Option<&'a NSWindow> {
    if ptr.is_null() {
        return None;
    }
    Some(&*(ptr as *const NSWindow))
}

/// 重申标题栏应处的样式位:全尺寸内容视图 + 透明标题栏。几何变化后 macOS 可能
/// 丢掉这些位,导致 webview 内容相对标题栏错位;这里幂等地补回来。
/// 返回是否实际调用了 setStyleMask(FSCV 位曾丢失)——这是诊断"重排竞态"的关键信号。
unsafe fn reassert_titlebar_style(window: &NSWindow) -> bool {
    let mask = window.styleMask();
    let wanted = mask | NSWindowStyleMask::FullSizeContentView;
    if wanted != mask {
        window.setStyleMask(wanted);
        window.setTitlebarAppearsTransparent(true);
        return true;
    }
    window.setTitlebarAppearsTransparent(true);
    false
}

/// 把三个交通灯按钮复位到既定内嵌位置,并把承载它们的标题栏容器视图重新贴到
/// 窗口顶部。移植自 decorum/Hoppscotch,用 objc2 类型化 API 重写。
unsafe fn reposition_traffic_lights(window: &NSWindow, x: f64, y: f64) {
    let close = window.standardWindowButton(NSWindowButton::CloseButton);
    let miniaturize = window.standardWindowButton(NSWindowButton::MiniaturizeButton);
    let zoom = window.standardWindowButton(NSWindowButton::ZoomButton);

    let close = match close {
        Some(b) => b,
        None => return, // 无交通灯(理论上不会发生在主窗口)——直接返回。
    };

    // close -> (按钮所在的 stack 视图) -> title_bar_container_view
    let close_superview = match close.superview() {
        Some(v) => v,
        None => return,
    };
    let title_bar_container_view = match close_superview.superview() {
        Some(v) => v,
        None => return,
    };

    let button_height = close.frame().size.height;
    let title_bar_frame_height = button_height + y;

    // 把标题栏容器视图重新对齐到窗口顶部。
    let window_height = window.frame().size.height;
    let mut container_frame = title_bar_container_view.frame();
    container_frame.size.height = title_bar_frame_height;
    container_frame.origin.y = window_height - title_bar_frame_height;
    title_bar_container_view.setFrame(container_frame);

    // 逐个复位按钮位置(macOS 坐标系原点在左下角)。
    let buttons = [Some(&*close), miniaturize.as_deref(), zoom.as_deref()];
    let mut idx = 0.0_f64;
    for maybe_btn in buttons.into_iter().flatten() {
        let origin = NSPoint {
            x: x + idx * BUTTON_SPACING,
            y: ((title_bar_frame_height - button_height) / 2.0) - VERTICAL_OFFSET,
        };
        maybe_btn.setFrameOrigin(origin);
        idx += 1.0;
    }
}

/// 对外入口:在主线程重申标题栏样式并复位交通灯。供 setup 及窗口事件回调调用。
///
/// # Safety
/// 必须在主线程调用(AppKit 要求)。`ns_window_ptr` 必须是有效的 NSWindow 指针。
///
/// 诊断日志(临时,排查"顶栏消失"用):记录触发事件、FSCV 位是否丢失、窗口与
/// content view 的 frame。content view 比窗口矮一截 = macOS 丢掉了
/// FullSizeContentView、webview 被错位的铁证。`Moved` 事件高频,不记。
pub unsafe fn refresh(ns_window_ptr: *mut std::ffi::c_void, event: &str) {
    if let Some(window) = ns_window_from_ptr(ns_window_ptr) {
        let log_it = event != "Moved";
        if log_it {
            let mask = window.styleMask();
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            eprintln!(
                "[mac_titlebar] ts={} event={} fscv_missing={} win={:?} content={:?}",
                ts,
                event,
                !mask.contains(NSWindowStyleMask::FullSizeContentView),
                window.frame(),
                window.contentView().map(|v| v.frame())
            );
        }
        let set_mask = reassert_titlebar_style(window);
        reposition_traffic_lights(window, TRAFFIC_LIGHT_PAD_X, TRAFFIC_LIGHT_PAD_Y);
        if log_it && set_mask {
            eprintln!(
                "[mac_titlebar]   after setStyleMask: win={:?} content={:?}",
                window.frame(),
                window.contentView().map(|v| v.frame())
            );
        }
        // 子视图树 dump(临时,排查"顶栏消失"用):content view 层有 WKWebView,
        // theme frame 层有标题栏容器。哪个视图的 frame 偏离预期,就是错位元凶。
        if log_it {
            use objc2::ClassType;
            if let Some(cv) = window.contentView() {
                for v in cv.subviews().iter() {
                    eprintln!(
                        "[mac_titlebar]   content-sub: {:?} frame={:?} hidden={}",
                        v.class().name(),
                        v.frame(),
                        v.isHidden()
                    );
                }
                if let Some(tf) = cv.superview() {
                    for v in tf.subviews().iter() {
                        eprintln!(
                            "[mac_titlebar]   frame-sub: {:?} frame={:?} hidden={}",
                            v.class().name(),
                            v.frame(),
                            v.isHidden()
                        );
                    }
                }
            }
        }
    }
}
