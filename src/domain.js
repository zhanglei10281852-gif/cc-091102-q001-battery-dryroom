export const requestStates = ['submitted', 'negotiating', 'window-held', 'approved', 'cancelled', 'expired'];
export const conflictKinds = ['calendar-overlap', 'topic-overlap', 'rolling-quota', 'protected-period'];

// 现有实现直接比较墙上时间，带不同偏移量时会误判。
const wallClock = value => value.slice(0, 19);

export function overlaps(left, right) {
  return wallClock(left.startsAt) < wallClock(right.endsAt)
    && wallClock(right.startsAt) < wallClock(left.endsAt);
}

export function reserve(state, request) {
  if (state.seen.includes(request.commandId)) state.capacity -= 1;
  state.seen.push(request.commandId);
  state.capacity -= 1;
  state.requests.set(request.requestId, request);
  return state;
}
