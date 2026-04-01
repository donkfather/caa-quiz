import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

const REMINDER_IDS = [
  "streak-reminder-0",
  "streak-reminder-1",
  "streak-reminder-2",
  "streak-reminder-3",
  "streak-reminder-4",
];

// Configure how notifications appear when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export async function requestPermission(): Promise<boolean> {
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === "granted") return true;

  const { status } = await Notifications.requestPermissionsAsync();
  return status === "granted";
}

export async function scheduleStreakReminder(hour: number, minute: number): Promise<void> {
  // Cancel existing reminder first
  await cancelStreakReminder();

  const hasPermission = await requestPermission();
  if (!hasPermission) return;

  const messages = [
    "Nu uita de streak! Rezolvă un test azi. ⚓",
    "Streak-ul tău te așteaptă! Un test rapid? 🔥",
    "Ești aproape de obiectiv! Completează un test. 🏅",
    "Marinarul bun exersează zilnic! ⛵",
    "Nu pierde streak-ul! Un quiz rapid te ține în formă. 💪",
  ];

  // Schedule 5 notifications cycling through messages, one per day
  for (let i = 0; i < messages.length; i++) {
    // Stagger by week: day 1 = msg 0, day 2 = msg 1, ..., day 6 = msg 0 again
    // Using weekly trigger with different weekdays wraps the cycle
    await Notifications.scheduleNotificationAsync({
      identifier: REMINDER_IDS[i],
      content: {
        title: "Chestionare Barca",
        body: messages[i],
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
        weekday: ((i % 7) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7, // 1=Sunday
        hour,
        minute,
      },
    });
  }

  // Schedule remaining 2 days of the week with cycled messages
  for (let i = 0; i < 2; i++) {
    await Notifications.scheduleNotificationAsync({
      identifier: `streak-reminder-extra-${i}`,
      content: {
        title: "Chestionare Barca",
        body: messages[i],
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
        weekday: (6 + i) as 6 | 7, // Friday, Saturday
        hour,
        minute,
      },
    });
  }
}

export async function testNotification(): Promise<void> {
  const hasPermission = await requestPermission();
  if (!hasPermission) return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: "Chestionare Barca",
      body: "Marinarul bun exersează zilnic! ⛵",
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 2 },
  });
}

export async function cancelStreakReminder(): Promise<void> {
  for (const id of REMINDER_IDS) {
    await Notifications.cancelScheduledNotificationAsync(id);
  }
  await Notifications.cancelScheduledNotificationAsync("streak-reminder-extra-0");
  await Notifications.cancelScheduledNotificationAsync("streak-reminder-extra-1");
}
