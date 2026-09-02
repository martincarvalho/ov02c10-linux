# Measuring a camera pipeline without fooling yourself

Every number in the README came out of this. It is written down because the
measurement was harder than the code, and because most of the time lost went to
measurements that looked fine and were not.

## The rules that survived

**Repeat the control on both sides.** Not A then B, but A, B, A — or better,
A, B, A, B. If the two A's disagree with each other by more than the difference
you are claiming between A and B, you have measured the room, not the change.
This caught four wrong conclusions here. It is the single highest-value habit
on the list.

**Measure against the code that would actually be replaced, running.** Two
techniques were measured against a weaker baseline and both reversed sign when
measured against the real one. See "Techniques that reversed sign" below.

**Know what your metric excludes.** A mask that selects "near-neutral pixels" to
check colour cannot find colour shading, because it excludes the tinted corners
by construction. It reported −2% where the flat field said −11%.

**Frame differencing under-reads a temporally filtered signal.** An IIR filter
correlates neighbouring frames, so `diff(frames).std()` shrinks more than the
noise actually shrank. Use the deviation of each frame about the temporal mean
instead.

**Hold brightness fixed when comparing across gain.** Noise depends strongly on
level as well as on gain, so a comparison at two gains and two brightnesses says
whatever the two scenes happened to be lit like. Measured that way the noise
here looked flat in gain; held at a fixed level across 108×, 137× and 248× the
exponent came out 0.51–0.60, which is the square root the physics predicts.

## What contaminated the measurements

**Monitors in shot.** Their content changes on its own. A map of per-pixel
temporal deviation showed 13 DN over the desk and screens against 1.5 DN over a
plain wall, with a frame-wide median of 4.14 that was almost entirely them. This
is the most dangerous kind of contamination because it does not move the
averages: brightness and gain agree across runs while the number you care about
moves 60%. Map the variance first, then choose the region.

**The AGC still converging.** It takes about 75 frames to settle and up to 120
to stop oscillating. Discarding 25 or 40 frames is not enough.

**Light drifting during a capture.** Removing each frame's global mean handles a
uniform drift. It does not handle a light that changes *shape* — for that, fit a
per-frame scale factor against the temporal mean by least squares, which cancels
a uniform multiplicative change exactly.

**Virtual cameras.** A libcamera build from source enumerates test-pattern
cameras alongside the real one, and the same index means different things in a
build tree and in the installed binary. A synthetic pattern gives perfectly
constant brightness, zero noise and 1145 fps — numbers that look excellent and
mean nothing. Check `cam -l`, and treat an absurd frame rate as a warning.

**A raw capture inheriting someone else's exposure.** Grabbing Bayer frames
straight from V4L2 uses whatever exposure was last programmed. One capture here
came out 65% saturated and produced plausible-looking channel ratios that were
pure clipping. Always check the median and the clipped fraction before trusting
a raw frame.

## Techniques that reversed sign

Both are sound techniques. Both helped a weaker baseline and hurt the real one.

**Motion-compensated temporal denoising.** Worth 1.66× when measured against a
fixed-alpha temporal filter. The filter that actually ships has a motion-adaptive
alpha, which already falls back on the current frame where the picture moves —
so compensation is largely a substitute for it rather than an addition. Measured
against that, on the same captured frames: 12.6% *worse* over a static
background, 5.6% better on a fully moving frame. A webcam frame is mostly
background. Off by default.

**Constraining white balance to the sensor's measured illuminants.** The ratios a
real light produces on a given sensor trace a curve, and an estimate off that
curve is one no light could have caused. Against whole-frame grey world this cut
the error from 8.1% to 3.6%. But the estimator that ships uses only the pixels
that already look neutral, and it is accurate to 1.9% against three independent
neutral surfaces — while sitting 3.5% off the five characterised illuminants,
because the room's LED is not one of them. Projecting onto the curve therefore
*injected* more error than it removed.

## Measuring framing rather than noise

Two of the upstream bugs were found with a method that works in a dark room,
because it measures geometry: capture the same scene at two resolutions, take
the temporal mean of each, and search for the scale and offset that maximise the
normalised correlation between the smaller image and the larger one reduced by
that scale.

With the room at 9 DN of brightness this still registered at 0.83 correlation —
standby LEDs make excellent landmarks. It showed a 640×480 stream displaying a
1391×1043 window of the sensor's 1920×1080 starting at (48, 22), where centring
a 4:3 window in a 16:9 frame calls for 1440×1080 starting at (240, 0).

## Getting a flat field

Four attempts. The three failures each taught something:

| Attempt | Result | Why |
| --- | --- | --- |
| Paper on the lens, aimed at the room | 21% asymmetry | The room is not a uniform source |
| White wall, two captures with the laptop rotated 180° | Both asymmetric, *same* sign | The shadow was the laptop's own and turned with the camera |
| White screen at close range, no paper | 15× falloff | An LCD is not Lambertian; it dims off-axis |
| Paper on the lens, aimed at the white screen | 4.2×, symmetric to 1% | Paper diffuses the panel's angle; light from behind it cannot be shadowed |

The rotation trick is sound but only cancels gradients fixed in the *room*.
Anything fixed to the camera — its own shadow, an LCD's viewing angle — turns
with it and survives.

Judge a flat field by symmetry, not by smoothness. Lens shading is close to
radially symmetric; illumination gradients are not. The good field here had
edges at 67% of centre top and bottom, 48% left and right — matching pairs, with
the sides lower because a 16:9 frame puts them further off axis.

## A recovery procedure that has never been run is not a recovery procedure

The script that reapplies all of this after a distribution update was broken for
weeks and nobody noticed, because nobody had run it from scratch. It was
generated with a plain `git diff` in a tree that is a *package extraction*, so it
carried the distribution's own patches along with the intended changes, and
conflicted with them on the next extraction. Test the recovery path from a clean
clone, and have it check before it applies so a mismatch explains itself.
