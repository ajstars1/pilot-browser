// Shared by the injection fixtures: the attacker origin is the other loopback site.
window.ATTACKER = `http://localhost:${Number(location.port) + 1}`;
