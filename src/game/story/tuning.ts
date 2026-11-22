import * as THREE from "three";

/**
 * Every number the story is balanced with, in one place.
 *
 * What they are balanced against: a flat-out run is 6.2 m/s (RUN in player.ts), an easy
 * walk 3 to 4.5; turning right round takes about 2.5 s. The yeti runs at 5.3 m/s after a
 * 2 s roar (CHASE and ROAR_TIME in yeti.ts). The fog passes exp(-(k d)^2) of what is
 * d metres off, k being about 0.045 to 0.07 a metre in ordinary air, calm to gust (a fifth
 * more on phones): a thing shows as a faint shape at about 25 m, plainly at 15, and is
 * gone past 40 to 60. Distances "by the fog" below are worked out from the air at that
 * moment (Sight.hiddenBeyond and Sight.seenWithin), as the share of a thing the fog lets through.
 *
 * The shape of a walk: a minute of forest; then, on a turn, a signpost ahead in the fog,
 * again and again until it is read; 40 to 75 s after reading, the yeti, head-on; a roar,
 * about 2.5 s to turn and run, and some 20 s of running to the hut's door.
 */

const deg = THREE.MathUtils.degToRad;

// --- The way the walker is going ---------------------------------------------------------

/** Slower than this, m/s, is not going anywhere. */
export const MOVING = 0.6;
/**
 * Facing this far off the way they were going, the walker has changed direction. Well under
 * the 60 degrees or so of a deliberate turn: the way itself drifts a little with every weave
 * round a tree, and a real turn must not come out a degree short.
 */
export const TURN = deg(40);
/** Within this of it they are still on their way: a wobble, a weave round a tree. */
export const COURSE_BAND = deg(20);
/** On their way, the way follows them: over this many metres. */
export const COURSE_FOLLOW = 25;
/** A new heading has settled once held within SETTLE_SPREAD for SETTLE_DIST metres and SETTLE_TIME seconds, turning no faster than TURN_STILL (rad/s). */
export const SETTLE_SPREAD = deg(14);
export const SETTLE_DIST = 4;
export const SETTLE_TIME = 1;
export const TURN_STILL = 0.3;
/** A lesser bend held this many metres becomes the way, without counting as a turn. */
export const BEND_ACCEPTED = 18;

// --- The signpost: when it comes -----------------------------------------------------------

/** Seconds of walking before the first signpost may come. */
export const SIGN_AFTER = 60;
/** Seen and walked past unread, another may come after this many seconds of walking. */
export const SIGN_AGAIN = 15;
/** It comes on a change of direction; walking straight on this long (seconds) brings it too. */
export const SIGN_STRAIGHT = 30;
/** Due, it waits for the new heading to settle, but no longer than this many seconds of walking. */
export const SIGN_UNSETTLED = 6;

// --- The signpost: where it goes -------------------------------------------------------------

/** It goes ahead where the fog, even in a thin streak, lets through no more than this share of it... */
export const SIGN_HIDE = 0.02;
/** ...but no nearer than SIGN_MIN, no further than SIGN_MAX, and SIGN_RIM inside the edge of the loaded forest. */
export const SIGN_MIN = 40;
export const SIGN_MAX = 60;
export const SIGN_RIM = 18;
/**
 * Spots tried, in order: this much further off, and this far to the side of the way (either
 * side first). Close beside the way for choice: on a phone held upright the view is narrow,
 * and a board more than 2 or 3 metres aside is not read in passing, only by turning to it.
 */
export const SIGN_DEEPER = [0, 4, 8];
export const SIGN_ASIDE = [1.6, -1.6, 2.2, -2.2, 3, -3, 4.2, -4.2];
/** The board is turned to face the way at this distance before it; no trunk or bough may stand between. */
export const SIGN_READ_FROM = 9;
/** Coming up, it should be in plain sight from here on: no trunk and no rise in the way. */
export const SIGN_SEEN_FROM = 22;
/** Not on a slope steeper than this, nor a step up or down of more than this from where it is read. */
export const SIGN_SLOPE = 0.35;
export const SIGN_STEP = 1.6;
/** Spots tried in one frame, the wait before another round when none will do, and the rounds after which the tests ease. */
export const SIGN_PER_FRAME = 6;
export const SIGN_RETRY = 0.6;
export const SIGN_EASES_AFTER = 4;

// --- The signpost: when it goes ------------------------------------------------------------

/** Nearer than where ordinary air lets this share through, and on screen, it has been seen. */
export const SIGN_NOTICED = 0.15;
/**
 * Left behind: off screen for SIGN_OFF_FOR seconds and further off than SIGN_PASSED, and than
 * where the fog lets no more than SIGN_LOST of it through. Then it is taken away, unseen.
 */
export const SIGN_OFF_FOR = 1.5;
export const SIGN_PASSED = 32;
export const SIGN_LOST = 0.06;
/** Once read it stands until it is this far behind, m (and out of view). */
export const SIGN_KEPT = 110;

// --- Reading the signpost ------------------------------------------------------------------

/**
 * Reading: from in front, the whole board on screen (every corner within READ_EDGE of the
 * middle, where 1 is the screen's edge), no further off than READ_DIST and at least
 * READ_SHARE of the screen's width across as seen (so less when seen from the side), for
 * READ_TIME seconds. Walking up to look at it reads it; so does running past within a few
 * metres; seen ten metres off in passing, it stays unread.
 */
export const READ_DIST = 10;
export const READ_SHARE = 0.05;
export const READ_EDGE = 1;
export const READ_TIME = 0.5;
/**
 * Nearer than this the board need not fit: facing it will do (its middle no further to the side
 * than CLOSE_EDGE, where 1 is the screen's edge), even stood right over it, looking past its top.
 */
export const READ_CLOSE = 6;
export const CLOSE_EDGE = 0.9;
/** Once read, the words stay on screen while the board is in sight, a little more loosely. */
export const SHOW_DIST = 12;
export const SHOW_SHARE = 0.04;
export const SHOW_EDGE = 1.05;

// --- The yeti: when and where it comes ---------------------------------------------------------

/**
 * It comes only once the sign has been read: no sooner than YETI_MIN seconds after, then with
 * the first gust of YETI_GUST or more (the snow begins to howl), and by YETI_MAX at the latest.
 */
export const YETI_MIN = 40;
export const YETI_MAX = 75;
export const YETI_GUST = 0.65;
/** It starts dead ahead, where the fog, even in a thin streak, lets through no more than this share of it... */
export const YETI_HIDE = 0.02;
/** ...but no nearer than YETI_NEAR, no further than YETI_FAR, and YETI_RIM inside the edge of the loaded forest. */
export const YETI_NEAR = 38;
export const YETI_FAR = 60;
export const YETI_RIM = 12;
/** Spots tried, in order: this far off dead ahead (radians), this much further away. */
export const YETI_BEARINGS = [0, 0.04, -0.04, 0.08, -0.08];
export const YETI_DEEPER = [0, 4, 8];

// --- The yeti: coming on, head-on --------------------------------------------------------------

/** Unseen in the fog it comes on at YETI_APPROACH m/s; from where ordinary air lets YETI_EMERGES of it through, at a heavy walk, YETI_STALK. */
export const YETI_APPROACH = 3;
export const YETI_STALK = 1.8;
export const YETI_EMERGES = 0.08;
/**
 * It does not make straight for the walker but for the way ahead of them, this share of the
 * distance between them along it: whichever way they have turned, it comes round in front.
 */
export const YETI_LEAD = 0.5;
/**
 * It has been seen coming once it has been in front for YETI_MET seconds, nearer than where
 * ordinary air lets YETI_SHOWS of it through. In front: its middle on screen, no further off
 * dead ahead than YETI_FRONT of half the view across, nor than YETI_FRONT_MAX (radians).
 */
export const YETI_SHOWS = 0.2;
export const YETI_MET = 0.5;
export const YETI_FRONT = 0.7;
export const YETI_FRONT_MAX = 0.55;
/**
 * Until it has been seen, it is kept in front. While the fog still veils it (no more than
 * YETI_VEILED of it coming through even a thin streak), it is moved back dead ahead, as far
 * off as it has come, whenever it is more than YETI_OFF to one side. Nearer than that, it is
 * put dead ahead again, back in the fog, once it has been off screen for YETI_LOST seconds,
 * at most once in YETI_SHIFT seconds.
 */
export const YETI_VEILED = 0.1;
export const YETI_OFF = Math.cos(deg(8));
export const YETI_LOST = 1.5;
export const YETI_SHIFT = 0.5;
/**
 * A walker who never lets it come (turning and turning) is come for anyway after this long:
 * it is held to the leash, roars as soon as it is near enough, in view or not, or as soon as
 * they turn their back on it.
 */
export const YETI_PATIENCE = 25;
/**
 * It rears up and roars, in view, YETI_ROAR_GAP metres off, further by as much as the walker
 * covers towards it during the roar (so whoever runs at it has as long to turn as whoever
 * stands), yet not so far that it could not be made out at all: no further than where
 * ordinary air lets YETI_ROAR_SEEN of it through. (That last costs someone sprinting at it
 * through the thickest gust up to half a second of their time to turn; a tenth, which would
 * show it plainly, cost them a second.)
 */
export const YETI_ROAR_GAP = 16;
export const YETI_ROAR_SEEN = 0.04;
/** Seen coming, turning this far away from it is running: it roars at once, and the hut is ahead. */
export const AWAY = Math.cos(deg(120));
/**
 * As it rears up to roar the head turns to it, whichever way the walker was looking (or
 * running), the view closing in on it, and they stand rooted for YETI_FOCUS seconds; then
 * the pointer has the head again. Its roar lasts that much longer than ROAR_TIME (yeti.ts),
 * so there is still as long to turn and run as there was. (Through the yeti's eyes the same
 * happens with the man it spots, for as long as it roars: HUNT_ROAR.)
 */
export const YETI_FOCUS = 1.2;

// --- The chase ---------------------------------------------------------------------------------

/** The yeti's hands reach this far. */
export const CAUGHT = 1.4;
/**
 * However far ahead the walker gets, the yeti is never further behind than this (closing in
 * out of sight to LEASH_SLACK nearer): near enough to hear its footfalls.
 */
export const LEASH = 34;
export const LEASH_SLACK = 4;
/** Running, it snarls every so often: after GROWL_EVERY seconds and up to GROWL_SPREAD more. */
export const GROWL_FIRST = 4;
export const GROWL_EVERY = 4.5;
export const GROWL_SPREAD = 4;

// --- The hut -----------------------------------------------------------------------------------

/** The hut stands about this far ahead of where you turn to run. */
export const HUT_DIST = [115, 105, 125];
/** The ground under the hut may rise or fall by at most this much: steeper, and it is not put there. */
export const HUT_UNEVEN = 1.4;
/** How far each choice of bearing may lie off the way ahead (radians), and what a radian aside costs in the score. */
export const HUT_BEARINGS = [0, 0.15, -0.15, 0.3, -0.3, 0.45, -0.45];
export const HUT_ASIDE = 3;
/** Run off somewhere else entirely and the hut is put ahead of you again. */
export const HUT_LOST = 170;
/**
 * Past this the blizzard hides the hut. The fog lets through exp(-(k d)^2) of what is
 * behind it, k being about 0.043 to 0.069 a metre in ordinary air (calm to gust; see fog.ts
 * and blizzard.ts): 2% at 45 m in a calm, nothing in a gust.
 */
export const HUT_UNSEEN = 45;
/**
 * Missed: the hut further off than HUT_UNSEEN and more than 40 degrees off the way you are
 * running, for HUT_MISSED_FOR seconds of running (HUT_RUNNING m/s or faster). Then it
 * stands ahead again, as soon as it is out of view.
 */
export const HUT_OFF_COURSE = Math.cos(deg(40));
export const HUT_MISSED_FOR = 2.5;
export const HUT_RUNNING = 1;
/**
 * A hut put ahead again goes dead on course: HUT_AGAIN metres off the first time, HUT_NEARER
 * less each time after, never nearer than HUT_AGAIN_MIN (or, for more level ground, a
 * little further: HUT_AGAIN_DEEPER). Even the thinnest streak of the calmest air (k about
 * 0.022) lets through under a tenth at 72 m, ordinary air nothing, so it never pops in.
 */
export const HUT_AGAIN = 88;
export const HUT_NEARER = 8;
export const HUT_AGAIN_MIN = 72;
export const HUT_AGAIN_DEEPER = [0, 7, 14];
export const HUT_AGAIN_BEARINGS = [0, 0.05, -0.05, 0.1, -0.1, 0.16, -0.16, 0.22, -0.22];
export const HUT_AGAIN_ASIDE = 6;
/** Seconds before another try when no place for it was found. */
export const HUT_RETRY = 1;
/** Once put ahead again, the hut stays put at least this long, however the way winds. */
export const HUT_REST = 6;
/** Close enough to the door, facing it, and in you go. */
export const DOOR_REACH = 3.5;
export const DOOR_FACING = 0.35;

// --- Going in ----------------------------------------------------------------------------------

/**
 * Going in: one unbroken glide from where you are, slowing from your own pace, into the
 * gap of the half-open door, the dark closing over as you near it. It takes about this
 * long (less when running in fast), and the dark holds a moment before the end screen.
 */
export const INSIDE_TIME = 2.4;
export const INSIDE_HOLD = 0.7;
/** The door swings to half open over this long. */
export const DOOR_TIME = 1.1;

// --- Caught ------------------------------------------------------------------------------------

/**
 * Caught: one unbroken movement. Over LIFT_TIME the walker is swung round to face it and
 * lifted up over its head; LOWER_LEAD before they get there it is already bringing them
 * down again, to its open jaws, over LOWER_TIME: up and straight down, with no pause at the
 * top. The dark closes over as the jaws come up close, and holds a moment before the end screen.
 */
export const LIFT_TIME = 1.6;
export const LOWER_LEAD = 0.25;
export const LOWER_TIME = 1.5;
export const DARK_HOLD = 0.5;
/** Brought down to its mouth, the eyes end up this far out in front of it. */
export const MOUTH_AHEAD = 0.28;
/** Lowered, its arms come down this far (a share of the way back from overhead). */
export const LOWERED = 0.45;
/** Held up, the eyes are this far above its hands, and this far out in front of them (HELD_REACH more as it first grabs). */
export const HELD_ABOVE = 0.45;
export const HELD_AHEAD = 0.12;
export const HELD_REACH = 0.45;

// --- The third walk: the yeti's hunt ------------------------------------------------------------

/**
 * Through the yeti's eyes. It ambles through deep forest (2.3 m/s at most, YETI_BODY in
 * player.ts), sees badly but sees heat, and the man glows through the fog well beyond where
 * his light is lost (HEAT_FOG in fog.ts). Once it has
 * roared it charges at up to YETI_CHARGE, its pace rising evenly with the pointer's offset;
 * the man runs for the hut at MAN_RUN (4.6 m/s, man.ts), losing a little each time he looks back.
 *
 * The balance: spotted at 17 to 22 m (SPOT_CLOSE, SPOT_DIST), the hut REFUGE_DIST (36 to
 * 54 m) on from him, he is at the door 8.7 to 12.7 s after the roar. Worked through frame
 * by frame on open ground, a yeti charging straight at him flat out (the pointer at the top
 * of the screen) has him every time, with 0.1 to 2.7 s to spare (about 0.9 for the usual
 * layout); at nine tenths of flat out it is a coin toss; at eight tenths he nearly always
 * gets away. Among the trees, with a chaser that steers for him with a quarter second's lag
 * and works its way round trunks, it had him about three times in four. Hard, on purpose:
 * this is the last walk.
 */
/** Seconds of walking before the man first comes, and up to this many more. */
export const HUNT_AFTER = 30;
export const HUNT_SPREAD = 12;
/** Lost track of before he was spotted, he comes again after this many seconds. */
export const HUNT_AGAIN = 4;
/**
 * He comes ahead, MAN_BEARINGS radians to one side (either), where even in a thin streak
 * of the clearest air lately the fog lets through no more than MAN_HIDE of his heat (which
 * it dims far less than light: HEAT_FOG in fog.ts), but no nearer than MAN_NEAR, no further
 * than MAN_FAR, and MAN_RIM inside the edge of the loaded forest; or MAN_DEEPER further for
 * room to stand. Until he is MAN_PASSING metres off he walks for a point MAN_PASS metres
 * to one side of the yeti, wherever it has got to, so that they meet however it winds
 * through the trees: a glow in the fog from about 45 m, a figure from 30; then he walks
 * on past it, MAN_GOAL metres at a time.
 */
export const MAN_HIDE = 0.03;
export const MAN_NEAR = 55;
export const MAN_FAR = 80;
export const MAN_RIM = 10;
/** Even so, he comes out of the fog over this many seconds: his glow fades up from nothing. */
export const MAN_EMERGE = 4;
export const MAN_BEARINGS = [0.14, 0.2, 0.08, 0.26];
export const MAN_DEEPER = [0, 5, 10];
export const MAN_PASS = 6;
export const MAN_PASSING = 14;
export const MAN_GOAL = 40;
/**
 * Unspotted, off screen for MAN_LOST_FOR seconds and further off than MAN_LOST (beyond
 * spotting), or out MAN_ROAM seconds and off screen, he is taken away, to come again ahead.
 * Running with no hut to run to, he is gone once off screen and MAN_GONE away.
 */
export const MAN_LOST_FOR = 10;
export const MAN_LOST = 26;
export const MAN_GONE = 46;
export const MAN_ROAM = 50;
/**
 * Spotted: in sight (on screen, no trunk square between, though nearer than SPOT_CLOSE his
 * glow shows through the boughs anyway) and nearer than SPOT_DIST, for SPOT_TIME seconds.
 * Nearer than HEARD (bumping into him from behind), he notices it whether it is seen or not.
 */
export const SPOT_DIST = 22;
export const SPOT_CLOSE = 17;
export const SPOT_TIME = 0.35;
export const HEARD = 5;
/** It stands this long, arms flung up, roaring; then it charges at up to YETI_CHARGE m/s. */
export const HUNT_ROAR = 1.3;
export const YETI_CHARGE = 7.6;
/**
 * The hut he runs for: REFUGE_DIST metres on from where he stands when it roars, on one of
 * REFUGE_BEARINGS off straight away from the yeti (a radian aside costing REFUGE_ASIDE in
 * the score), out of view or where the fog lets through no more than REFUGE_HIDE of it.
 */
export const REFUGE_DIST = [40, 44, 36, 48, 54];
export const REFUGE_BEARINGS = [0, 0.25, -0.25, 0.5, -0.5, 0.75, -0.75, 1, -1];
export const REFUGE_ASIDE = 1.5;
export const REFUGE_HIDE = 0.1;
/**
 * Its hands reach him from GRAB metres. He runs for a point DOORSTEP_OUT out from the
 * doorway, and within DOORSTEP_REACH of it he goes in (over MAN_ENTER in man.ts); up to
 * IN_THE_DOOR of the way through he can still be dragged out.
 */
export const GRAB = 1.7;
export const DOORSTEP_OUT = 0.6;
export const DOORSTEP_REACH = 0.9;
export const IN_THE_DOOR = 0.55;
/** If he has not got in by now, he never will be caught either: it ends as an escape. */
export const HUNT_GIVE_UP = 45;
/** He is in, the door shut: the yeti stands looking at it this long, then the dark comes over SHUT_DARK. */
export const SHUT_HOLD = 1.2;
export const SHUT_DARK = 1.8;
/**
 * Caught, through its eyes: over FEAST_LIFT it hauls him up overhead by the middle, its
 * hands reaching for HELD_UP above its eyes and HELD_OUT in front, as high as its arms go
 * (he is held between its palms wherever they get to); FEAST_LEAD before he is all the way
 * up it brings him down again, over FEAST_LOWER, his face to its mouth, his waist ending
 * MOUTH_DOWN below its eyes and MOUTH_OUT in front, tipped towards it. The dark comes as
 * he comes close, and holds FEAST_HOLD.
 */
export const FEAST_LIFT = 1.5;
export const FEAST_LEAD = 0.2;
export const FEAST_LOWER = 1.5;
export const FEAST_HOLD = 0.6;
export const HELD_UP = 0.75;
export const HELD_OUT = 0.95;
export const MOUTH_DOWN = 0.75;
export const MOUTH_OUT = 0.9;
