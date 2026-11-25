import { useTranslation } from "react-i18next";
import NotificationSettings from "../../profile/components/NotificationSettings.tsx";
import { SettingsGroup } from "../../profile/components/SettingsGroup.tsx";

export default function NotificationsPage() {
  const { t } = useTranslation();
  return (
    <SettingsGroup title={t("profile.notifications")} description={t("profile.notificationsLead")}>
      <NotificationSettings />
    </SettingsGroup>
  );
}
