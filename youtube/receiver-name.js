// Run in the page's MAIN world at document_start, before YouTube initializes.
(() => {
  if (location.hostname !== "www.youtube.com" ||
      !/^\/tv(?:\/|$)/.test(location.pathname)) return;

  const patch = environment => {
    if (environment && typeof environment === "object") {
      environment.feature_switches ||= {};
      environment.feature_switches.mdx_device_label = "RaspPi";
    }
    return environment;
  };

  let environment = patch(window.environment);
  Object.defineProperty(window, "environment", {
    configurable: true,
    enumerable: true,
    get() { return patch(environment); },
    set(value) { environment = patch(value); }
  });
})();
