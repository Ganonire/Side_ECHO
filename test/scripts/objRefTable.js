const C3 = self.C3;
self.C3_GetObjectRefTable = function () {
	return [
		C3.Plugins.TiledBg,
		C3.Plugins.Sprite,
		C3.Behaviors.scrollto,
		C3.Plugins.Text,
		C3.Behaviors.Anchor,
		C3.Plugins.Button,
		C3.Plugins.Audio
	];
};
self.C3_JsPropNameTable = [
	{tiledBackground: 0},
	{ScrollTo: 0},
	{cameraObj: 0},
	{Energy: 0},
	{roomSelect: 0},
	{varManager: 0},
	{Anchor: 0},
	{energyText: 0},
	{energyButton: 0},
	{changeFrameButton: 0},
	{energyBar: 0},
	{energyBarBg: 0},
	{energyButton2: 0},
	{energyButton3: 0},
	{energySegment: 0},
	{listButton: 0},
	{listPanel: 0},
	{listItem1: 0},
	{listItem2: 0},
	{listItem3: 0},
	{Audio: 0},
	{coffeeButton: 0}
];

self.InstanceType = {
	tiledBackground: class extends self.ITiledBackgroundInstance {},
	cameraObj: class extends self.ISpriteInstance {},
	varManager: class extends self.ISpriteInstance {},
	energyText: class extends self.ITextInstance {},
	energyButton: class extends self.IButtonInstance {},
	changeFrameButton: class extends self.IButtonInstance {},
	energyBar: class extends self.ISpriteInstance {},
	energyBarBg: class extends self.ISpriteInstance {},
	energyButton2: class extends self.IButtonInstance {},
	energyButton3: class extends self.IButtonInstance {},
	energySegment: class extends self.ISpriteInstance {},
	listButton: class extends self.ISpriteInstance {},
	listPanel: class extends self.ISpriteInstance {},
	listItem1: class extends self.ISpriteInstance {},
	listItem2: class extends self.ISpriteInstance {},
	listItem3: class extends self.ISpriteInstance {},
	Audio: class extends self.IInstance {},
	coffeeButton: class extends self.IButtonInstance {}
}