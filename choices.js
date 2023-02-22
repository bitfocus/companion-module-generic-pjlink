
//  constants for choices/dropdowns

export const ERROR_TYPES = [
	{ id: 'errorFan', label: 'Fan' },
	{ id: 'errorLamp', label: 'Lamp' },
	{ id: 'errorTemp', label: 'Temp' },
	{ id: 'errorCover', label: 'Cover' },
	{ id: 'errorFilter', label: 'Filter' },
	{ id: 'errorOther', label: 'Other' },
]

export const ERROR_STATE = [
	'No Error',		// 0
	'Warning',		// 1
	'Error',		// 2
]

export const ON_OFF_STATE = [
	'Off',		// 0
	'On' ,		// 1
]

export const ON_OFF_TOGGLE = [
	'Off',		// 0
	'On' ,		// 1
	'Toggle',	// 2
]
export const INPUTS = [
	{ id: '11', label: 'RGB1 (11)' },
	{ id: '12', label: 'RGB2 (12)' },
	{ id: '31', label: 'DVI-D (31)' },
	{ id: '32', label: 'HDMI (32)' },
	{ id: '33', label: 'Digital link (33)' },
	{ id: '34', label: 'SDI1 (34)' },
	{ id: '35', label: 'SDI2 (35)' },
	{ id: '52', label: 'LAN (52)' },
	{ id: '56', label: 'HDBaseT (56)' },
]

export const INPUT_CLASS = {
	'1': 'RGB',
	'2': 'Video' ,
	'3': 'Digital' ,
	'4': 'Storage' ,
	'5': 'Network' ,
	'6': 'Internal',
}

export const MUTE_ITEM = [
	'Not Muted',	// 0
	'Video Mute',	// 1
	'Audio Mute',	// 2
	'A/V mute',		// 3
]

export const POWER_STATE = [
	'Off',		// 0
	'On',		// 1
	'Cooling',	// 2
	'Warm-up',	// 3
]
