import { isTauri } from "./runtime";

export async function notificationPermissionGranted(): Promise<boolean> {
  if (isTauri) {
    const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
    return isPermissionGranted();
  }
  return "Notification" in window && Notification.permission === "granted";
}

export async function requestNotificationAccess(): Promise<boolean> {
  if (isTauri) {
    const { isPermissionGranted, requestPermission } = await import(
      "@tauri-apps/plugin-notification"
    );
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  }
  if (!("Notification" in window)) return false;
  return (
    Notification.permission === "granted" || (await Notification.requestPermission()) === "granted"
  );
}

export async function sendDesktopNotification(
  title: string,
  body: string,
  operationId: string,
): Promise<void> {
  if (isTauri) {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification({ title, body });
    return;
  }
  new Notification(title, { body, tag: operationId });
}
