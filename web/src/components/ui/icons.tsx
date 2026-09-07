import { HugeiconsIcon, type HugeiconsIconProps } from '@hugeicons/react';
import {
  Activity01Icon,
  Add01Icon,
  Analytics01Icon,
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowLeft02Icon,
  ArrowRight02Icon,
  ArrowUpDownIcon,
  Calendar03Icon,
  Cancel01Icon,
  ChartNoAxesCombinedIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  ComputerIcon,
  Copy01Icon,
  Cursor01Icon,
  Delete02Icon,
  Download01Icon,
  File01Icon,
  FootprintsIcon,
  Globe02Icon,
  LinkSquare02Icon,
  Loading03Icon,
  Logout01Icon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  Search01Icon,
  Settings02Icon,
  SidebarLeft01Icon,
  SourceCodeIcon,
  SparklesIcon,
  Tick02Icon,
  UserIcon,
  ViewIcon,
  ViewOffIcon,
} from '@hugeicons/core-free-icons';

type IconProps = Omit<HugeiconsIconProps, 'icon'>;

// Centralize the icon family while preserving SVG and accessibility props.
function iconComponent(icon: HugeiconsIconProps['icon']) {
  return function AppIcon(props: IconProps) {
    return (
      <HugeiconsIcon
        aria-hidden={props['aria-label'] || props.role ? undefined : true}
        data-icon-family="hugeicons"
        {...props}
        icon={icon}
      />
    );
  };
}

export const Activity = iconComponent(Activity01Icon);
export const ArrowDown = iconComponent(ArrowDown02Icon);
export const ArrowLeft = iconComponent(ArrowLeft02Icon);
export const ArrowRight = iconComponent(ArrowRight02Icon);
export const BarChart3 = iconComponent(Analytics01Icon);
export const CalendarDays = iconComponent(Calendar03Icon);
export const ChartNoAxesCombined = iconComponent(ChartNoAxesCombinedIcon);
export const Check = iconComponent(Tick02Icon);
export const CheckIcon = iconComponent(Tick02Icon);
export const ChevronDown = iconComponent(ArrowDown01Icon);
export const ChevronsUpDown = iconComponent(ArrowUpDownIcon);
export const ChevronsUpDownIcon = iconComponent(ArrowUpDownIcon);
export const CircleCheck = iconComponent(CheckmarkCircle02Icon);
export const Clock3 = iconComponent(Clock01Icon);
export const Code2 = iconComponent(SourceCodeIcon);
export const Copy = iconComponent(Copy01Icon);
export const Download = iconComponent(Download01Icon);
export const ExternalLink = iconComponent(LinkSquare02Icon);
export const Eye = iconComponent(ViewIcon);
export const EyeOff = iconComponent(ViewOffIcon);
export const FileText = iconComponent(File01Icon);
export const Footprints = iconComponent(FootprintsIcon);
export const Globe2 = iconComponent(Globe02Icon);
export const Loader2Icon = iconComponent(Loading03Icon);
export const LogOut = iconComponent(Logout01Icon);
export const Monitor = iconComponent(ComputerIcon);
export const MousePointer2 = iconComponent(Cursor01Icon);
export const PanelLeftIcon = iconComponent(SidebarLeft01Icon);
export const Pause = iconComponent(PauseIcon);
export const Play = iconComponent(PlayIcon);
export const Plus = iconComponent(Add01Icon);
export const RefreshCw = iconComponent(RefreshIcon);
export const Search = iconComponent(Search01Icon);
export const Settings2 = iconComponent(Settings02Icon);
export const Sparkles = iconComponent(SparklesIcon);
export const Trash2 = iconComponent(Delete02Icon);
export const X = iconComponent(Cancel01Icon);
export const XIcon = iconComponent(Cancel01Icon);
export const User = iconComponent(UserIcon);
