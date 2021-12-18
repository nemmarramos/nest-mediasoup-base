RELEASE 1.0.1
- Initial release

RELEASE 1.0.3
- Emitting to sendMessage event will broadcast message to all users in the room except the sender.
- Room consume function will use room's host media producer to consume if toConsumePeerId is undefined.

RELEASE 1.0.4
- Update peerDependencies @nestjs/common to v8.2.0

RELEASE 1.1.0
- Added IRoom interface.
- BaseGateway generic type for extending room functionalities.

RELEASE 1.1.1
- Emit newProducer event when someone produce A/V.

RELEASE 1.1.2
- Room attributes changed to protected var.

RELEASE 1.1.3
- Base room class attribute baseLogger changed from protected to private var.
- Load room function will call now room as T generic.
- Added closeProducerTransports function in base room for closing of client producer transports.

RELEASE 1.1.4
- Add user profile attribute in active callers collection.
