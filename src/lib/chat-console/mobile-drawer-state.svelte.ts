export const mobileDrawerState = $state({ left: false, right: false });

export function openLeft() {
	mobileDrawerState.right = false;
	mobileDrawerState.left = true;
}

export function openRight() {
	mobileDrawerState.left = false;
	mobileDrawerState.right = true;
}

export function closeAll() {
	mobileDrawerState.left = false;
	mobileDrawerState.right = false;
}
