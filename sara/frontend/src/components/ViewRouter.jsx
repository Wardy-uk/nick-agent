import { useSaraState } from '../state/saraState';
import { SARA_VIEWS } from '../state/views';
import CognitionEnvironment from '../screens/cognition/CognitionEnvironment';
import ContextView from '../screens/context/ContextView';
import MissionControl from '../screens/mission-control/MissionControl';
import ExecutiveDashboard from '../screens/executive-dashboard/ExecutiveDashboard';
import AtWorkView from '../screens/at-work/AtWorkView';
import StandupView from '../screens/standup/StandupView';
import TeamView from '../screens/team/TeamView';
import FocusView from '../screens/focus/FocusView';
import CompanionView from '../screens/companion/CompanionView';
import TodosView from '../screens/todos/TodosView';
import VaultView from '../screens/vault/VaultView';
import CaptureView from '../screens/capture/CaptureView';
import SettingsView from '../screens/settings/SettingsView';
import PresenceView from '../screens/presence/PresenceView';
import PlannedView from './PlannedView';

// ViewRouter — renders the screen for the current view.
//
// This is the seam that makes "one state, many views" real: the current view is a
// value in shared state, and the router maps it to a screen. The product-facing screen
// set can evolve without changing the shared-state model underneath it.
export default function ViewRouter() {
  const { currentView } = useSaraState();

  switch (currentView) {
    case SARA_VIEWS.PRESENCE:
      return <PresenceView />;
    case SARA_VIEWS.COGNITION:
      return <CognitionEnvironment />;
    case SARA_VIEWS.CONTEXT:
      return <ContextView />;
    case SARA_VIEWS.BRIEFING:
      return <MissionControl />;
    case SARA_VIEWS.SARA:
      return <CompanionView />;
    case SARA_VIEWS.STANDUP:
      return <StandupView />;
    case SARA_VIEWS.QUEUE:
      return <ExecutiveDashboard />;
    case SARA_VIEWS.ATWORK:
      return <AtWorkView />;
    case SARA_VIEWS.TEAM:
      return <TeamView />;
    case SARA_VIEWS.FOCUS:
      return <FocusView />;
    case SARA_VIEWS.TODOS:
      return <TodosView />;
    case SARA_VIEWS.VAULT:
      return <VaultView />;
    case SARA_VIEWS.CAPTURE:
      return <CaptureView />;
    case SARA_VIEWS.SETTINGS:
      return <SettingsView />;
    default:
      return <PlannedView viewId={currentView} />;
  }
}
