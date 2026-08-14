import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Download,
  Eye,
  FileText,
  Film,
  HelpCircle,
  Layers,
  ListFilter,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Search,
  SkipBack,
  SkipForward,
  Sliders,
  Smile,
  Sparkles,
  Square,
  Upload,
  Users,
  Volume1,
  Volume2,
  VolumeX,
  X,
  Zap,
} from 'lucide';

const iconMap = {
  play: Play,
  pause: Pause,
  stop: Square,
  skipBack: SkipBack,
  skipForward: SkipForward,
  volume: Volume2,
  volumeLow: Volume1,
  volumeMute: VolumeX,
  upload: Upload,
  file: FileText,
  users: Users,
  film: Film,
  sparkles: Sparkles,
  sliders: Sliders,
  check: Check,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  help: HelpCircle,
  close: X,
  mic: Mic,
  replay: RotateCcw,
  layers: Layers,
  zap: Zap,
  book: BookOpen,
  cpu: Cpu,
  smile: Smile,
  eye: Eye,
  filter: ListFilter,
  search: Search,
  download: Download,
};

/**
 * Creates SVG icon string from Lucide icon data
 */
export function getIconSvg(name, size = 18, className = '') {
  const iconData = iconMap[name];
  if (!iconData || !Array.isArray(iconData)) return '';

  const childMarkup = iconData
    .map(([tag, attrs]) => {
      const attrStr = Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      return `<${tag} ${attrStr}></${tag}>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide-icon ${className}">${childMarkup}</svg>`;
}
