import coffeeImg from "@assets/buy_me_a_coffee.png?url";
import { openExternal } from "../../ipc/api";

const COFFEE_URL = "https://buymeacoffee.com/vador";

export function BuyMeACoffeeButton() {
  return (
    <button
      type="button"
      onClick={() => openExternal(COFFEE_URL)}
      title="Buy me a coffee"
      aria-label="Buy me a coffee"
      className="block w-[65%] rounded-lg overflow-hidden transition-transform hover:scale-[1.02] active:scale-100 cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <img
        src={coffeeImg}
        alt="Buy me a coffee"
        className="block w-full h-auto"
        draggable={false}
      />
    </button>
  );
}
