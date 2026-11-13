// Roster data: playable badgers, rival mascots, kart classes, perks and items.

export const WISCONSIN_ID = '275';

const badgerLook = (c1, c2, sweater) => ({
  c1, c2, sweater, fur: 0xf4f4f4, ears: 'round', snout: 'short', extra: 'stripes',
});

/** Playable racers. Only one player may be Bucky (`unique`). */
export const BADGERS = [
  { key: 'bucky', name: 'Bucky', unique: true, look: badgerLook(0xc5050c, 0xffffff, 0xc5050c) },
  { key: 'cardinal', name: 'Cardinal Badger', look: badgerLook(0x8a0000, 0x222222, 0xffffff) },
  { key: 'frost', name: 'Frost Badger', look: badgerLook(0xf2f2f2, 0xc5050c, 0x9fd3ff) },
  { key: 'night', name: 'Night Badger', look: badgerLook(0x1c1c1c, 0xc5050c, 0x333333) },
  { key: 'gold', name: 'Golden Badger', look: badgerLook(0xd9a520, 0x222222, 0xd9a520) },
];

// id = ESPN team id, used to match live rankings / results.
const T = (id, school, abbr, mascot, c1, c2, fur, ears, snout, extra) => ({
  id: String(id), school, abbr, mascot, look: { c1, c2, fur, ears, snout, extra },
});

export const ROSTER = [
  T(135, 'Minnesota', 'MINN', 'Gopher', 0x7a0019, 0xffcc33, 0xc8862d, 'round', 'short', 'teeth'),
  T(2294, 'Iowa', 'IOWA', 'Hawk', 0x111111, 0xffcd00, 0xffcd00, 'none', 'beak', 'crest'),
  T(130, 'Michigan', 'MICH', 'Wolverine', 0x00274c, 0xffcb05, 0x6b4a2b, 'round', 'short', null),
  T(194, 'Ohio State', 'OSU', 'Buckeye', 0xbb0000, 0x999999, 0x5a2d0c, 'none', 'none', 'nut'),
  T(213, 'Penn State', 'PSU', 'Lion', 0x041e42, 0xffffff, 0xcfa15a, 'round', 'short', 'mane'),
  T(158, 'Nebraska', 'NEB', 'Husker', 0xe41c38, 0xfdf2d9, 0xf0c8a0, 'none', 'none', 'hat'),
  T(356, 'Illinois', 'ILL', 'Illini', 0x13294b, 0xe84a27, 0xf0c8a0, 'none', 'none', 'helmet'),
  T(77, 'Northwestern', 'NU', 'Wildcat', 0x4e2a84, 0xffffff, 0x8a8a8a, 'point', 'short', null),
  T(2509, 'Purdue', 'PUR', 'Boilermaker', 0x111111, 0xcfb991, 0xf0c8a0, 'none', 'none', 'hat'),
  T(84, 'Indiana', 'IU', 'Hoosier', 0x990000, 0xeeedeb, 0xf0c8a0, 'none', 'none', 'helmet'),
  T(127, 'Michigan State', 'MSU', 'Spartan', 0x18453b, 0xffffff, 0xf0c8a0, 'none', 'none', 'helmet'),
  T(120, 'Maryland', 'MD', 'Terrapin', 0xe03a3e, 0xffd520, 0x4f8a3c, 'none', 'short', null),
  T(164, 'Rutgers', 'RUTG', 'Knight', 0xcc0033, 0x5f6a72, 0xb0b0b0, 'none', 'none', 'helmet'),
  T(2483, 'Oregon', 'ORE', 'Duck', 0x154733, 0xfee123, 0xffffff, 'none', 'beak', null),
  T(30, 'USC', 'USC', 'Trojan', 0x990000, 0xffc72c, 0xf0c8a0, 'none', 'none', 'helmet'),
  T(26, 'UCLA', 'UCLA', 'Bruin', 0x2d68c4, 0xf2a900, 0x7a4b22, 'round', 'short', null),
  T(264, 'Washington', 'WASH', 'Husky', 0x4b2e83, 0xb7a57a, 0xd8d8d8, 'point', 'short', null),
  T(333, 'Alabama', 'BAMA', 'Elephant', 0x9e1b32, 0xffffff, 0x9a9a9a, 'big', 'trunk', null),
  T(61, 'Georgia', 'UGA', 'Bulldog', 0xba0c2f, 0x111111, 0xf2f2f2, 'flop', 'short', null),
  T(87, 'Notre Dame', 'ND', 'Leprechaun', 0x0c2340, 0xc99700, 0xf0c8a0, 'none', 'none', 'hat'),
  T(251, 'Texas', 'TEX', 'Longhorn', 0xbf5700, 0xffffff, 0xbf5700, 'none', 'short', 'horns'),
  T(99, 'LSU', 'LSU', 'Tiger', 0x461d7c, 0xfdd023, 0xf08a1c, 'round', 'short', null),
  T(57, 'Florida', 'FLA', 'Gator', 0x0021a5, 0xfa4616, 0x3f8f3a, 'none', 'long', null),
  T(228, 'Clemson', 'CLEM', 'Tiger', 0xf56600, 0x522d80, 0xf08a1c, 'round', 'short', null),
  T(2390, 'Miami', 'MIA', 'Ibis', 0xf47321, 0x005030, 0xffffff, 'none', 'beak', null),
  T(2633, 'Tennessee', 'TENN', 'Hound', 0xff8200, 0xffffff, 0x9c6b3f, 'flop', 'short', null),
  T(201, 'Oklahoma', 'OU', 'Sooner', 0x841617, 0xfdf9d8, 0xf5f5f5, 'point', 'long', null),
  T(145, 'Ole Miss', 'MISS', 'Landshark', 0xce1126, 0x14213d, 0x7f95a8, 'none', 'long', 'crest'),
  T(245, 'Texas A&M', 'TAMU', 'Collie', 0x500000, 0xffffff, 0xb5651d, 'point', 'long', null),
  T(254, 'Utah', 'UTAH', 'Ute Hawk', 0xcc0000, 0xffffff, 0x8b1a1a, 'none', 'beak', 'crest'),
];

/** Kart classes. Multipliers on base stats. */
export const KARTS = [
  { key: 'sprinter', name: 'Sprinter', desc: 'Highest top speed, slower to get there', top: 1.04, accel: 0.88, turn: 0.95, drift: 1, spin: 1 },
  { key: 'drifter', name: 'Drifter', desc: 'Tighter turns. Drifting charges boost faster.', top: 1.0, accel: 1.0, turn: 1.12, drift: 1.5, spin: 1 },
  { key: 'bruiser', name: 'Bruiser', desc: 'Quick launch, heavy, recovers from hits fast', top: 0.985, accel: 1.22, turn: 1.0, drift: 1, spin: 0.7, heavy: true },
];

/** Starting perks chosen before the race. */
export const PERKS = [
  { key: 'rocket', name: 'Full Boost', desc: 'Start with a full boost bar.' },
  { key: 'pocket', name: 'Curd Pocket', desc: 'Begin holding a Cheese Curd' },
  { key: 'lucky', name: 'Lucky Box', desc: 'Item boxes roll better items' },
  { key: 'fur', name: 'Thick Fur', desc: 'Spin-outs last half as long' },
];

export const ITEMS = {
  curd: { icon: '🧀', name: 'Cheese Curd' },
  football: { icon: '🏈', name: 'Homing Football' },
  slick: { icon: '🧈', name: 'Butter Slick' },
  cone: { icon: '🍦', name: 'Ice Cream Boost' },
  shield: { icon: '🛡️', name: 'Cheesehead Shield' },
  boombox: { icon: '📻', name: 'Jump Around' },
  blizzard: { icon: '❄️', name: 'Blizzard' },
};
